// OpenCode Go chat client: an Anthropic-compatible endpoint, so the island can
// talk to OpenCode's models with a key from the user's Go plan.
//
// Everything happens here rather than in the island: the API key never leaves
// the Credential Manager, and file bytes never cross the IPC boundary.

use serde_json::{json, Value};

use crate::claude::{self, Chat, ChatContext, ChatReply};
use crate::secrets;

const ENDPOINT: &str = "https://opencode.ai/zen/go/v1/messages";
const KEY_NAME: &str = "opencode-api-key";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const MAX_TOKENS: u32 = 4096;

pub const DEFAULT_MODEL: &str = "qwen3.8-flash";

const SYSTEM_PROMPT: &str = "You are Choom, a personal AI assistant living at the top of the user's screen. \
You can help with absolutely anything: research, coding, finding places, recommendations, tasks, questions. \
Respond in the user's language. Be thorough and complete: use as much detail as the task requires. \
No markdown formatting (no **, no ##, no bullet dashes). Use plain text with line breaks.";

/// Request body for the Anthropic-compatible endpoint: the models on it support
/// neither server tools nor fallbacks, so neither is sent.
pub fn build_body(model: &str, messages: Vec<Value>) -> Value {
    json!({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "system": SYSTEM_PROMPT,
        "messages": messages,
    })
}

/// One chat turn against OpenCode Go. Returns the assistant's text, or a
/// message the island shows in the note view.
pub async fn send(
    chat: &Chat,
    model: &str,
    query: String,
    context: Option<ChatContext>,
) -> Result<ChatReply, String> {
    let key = secrets::get(KEY_NAME)
        .ok_or_else(|| "OpenCode key missing. Open settings.".to_string())?;

    let mut content: Vec<Value> = Vec::new();

    // File / window context rides along with the first message only, exactly
    // like claude::send().
    if chat.is_empty() {
        match &context {
            Some(ChatContext::File { name, path }) => {
                if let Some(block) = claude::file_block(path) {
                    content.push(block);
                }
                content.push(json!({ "type": "text", "text": format!("File: {name}") }));
            }
            Some(ChatContext::Window { app_name, title, url }) => {
                let mut text = format!("Context: App: {app_name}, Window: {title}");
                if let Some(url) = url {
                    text.push_str(&format!(", URL: {url}"));
                }
                content.push(json!({ "type": "text", "text": text }));
            }
            None => {}
        }
    }
    content.push(json!({ "type": "text", "text": query }));

    chat.push(json!({ "role": "user", "content": content }));

    let body = build_body(model, chat.snapshot());

    let response = match call(&key, &body).await {
        Ok(v) => v,
        Err(err) => {
            chat.pop(); // keep the history consistent with what the model saw
            return Err(err);
        }
    };

    // A policy decline comes back as HTTP 200 with stop_reason "refusal".
    if response.get("stop_reason").and_then(Value::as_str) == Some("refusal") {
        chat.pop();
        let why = response
            .get("stop_details")
            .and_then(|d| d.get("explanation"))
            .and_then(Value::as_str)
            .unwrap_or("The model declined this one.");
        return Err(why.to_string());
    }

    let Some(blocks) = response.get("content").and_then(Value::as_array).cloned() else {
        chat.pop();
        return Err("Unexpected API response.".into());
    };

    // Only text blocks go back into the history: thinking blocks are rejected
    // when they come back as input on the next turn.
    let kept = text_blocks(&blocks);
    let text = kept
        .iter()
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();

    if text.is_empty() {
        chat.pop();
        return Err("No response text.".into());
    }
    chat.push(json!({ "role": "assistant", "content": kept }));
    Ok(ChatReply { text })
}

async fn call(key: &str, body: &Value) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| e.to_string())?;

    // The auth header is undocumented: send the key both ways.
    let response = client
        .post(ENDPOINT)
        .header("x-api-key", key)
        .header("authorization", format!("Bearer {key}"))
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json")
        .json(body)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        // Surface the API's own message, which is what makes a bad key obvious.
        let detail = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| {
                v.get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| text.chars().take(200).collect());
        return Err(format!("OpenCode Go {status}: {detail}"));
    }
    serde_json::from_str(&text).map_err(|e| format!("Bad API response: {e}"))
}

/// Filter a content array down to its text blocks.
fn text_blocks(blocks: &[Value]) -> Vec<Value> {
    blocks
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{build_body, text_blocks};
    use serde_json::json;

    #[test]
    fn body_has_the_model_and_system_but_no_tools_or_fallbacks() {
        let body = build_body("qwen3.8-flash", vec![json!({ "role": "user", "content": "hi" })]);
        assert_eq!(body["model"], "qwen3.8-flash");
        assert!(body.get("system").is_some());
        assert!(body.get("tools").is_none());
        assert!(body.get("fallbacks").is_none());
    }

    #[test]
    fn mixed_blocks_keep_only_text() {
        let blocks = vec![
            json!({ "type": "thinking", "thinking": "hmm" }),
            json!({ "type": "text", "text": "Hello" }),
            json!({ "type": "tool_use", "id": "call_1" }),
        ];
        assert_eq!(text_blocks(&blocks), vec![json!({ "type": "text", "text": "Hello" })]);
    }
}
