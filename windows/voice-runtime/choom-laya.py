#!/usr/bin/env python3
"""Choom Laya worker: a private owned stdin/stdout JSON worker.

One process, one serial inference at a time, no HTTP server, no downloads and
no cloud fallback. The native side owns this process, sends strict bounded
JSON lines on stdin and reads strict bounded JSON lines on stdout. Input lines
are read with a cap and oversized lines are drained in bounded chunks, so a
hostile line can never force a whole-line allocation.

Protocol (one JSON object per line):
  {"cmd": "decide", "id": <int>, "generation": <int>, "text": <str<=500>}
    -> {"ok": true, "id", "generation", "label", "selected_probability",
        "probabilities": {<label>: float, ...}}
    -> {"ok": false, "id", "generation", "error": "<reason>"}
  {"cmd": "exit"} -> process exits 0.

The label set is fixed: answer, options, clarify, supported_local, unknown.
The worker never invents labels, targets, paths or commands, and it echoes
only the request id and generation: the raw request text never appears in any
output. Output fields: `probabilities` is the raw selected distribution for
all five labels and `selected_probability` is that distribution's score for
the selected label. The model's `confidence` field is an entropy-derived
score and is deliberately not reported; `answer_confidence` in the raw model
result is the selected-label probability, which is what this contract
surfaces. Request-time failures emit bounded own messages or the generic
"inference failed", never a raw exception that could echo text.

Startup: choom-laya.py --model <model dir> --manifest <manifest json>
Validates the manifest (bounded size, exact required file set, safe relative
paths, resolved-path containment inside the model root, recorded sizes and
SHA-256 hashes) before any load, loads offline on CPU with four threads,
performs one real warm-up inference, then emits
{"ok": true, "event": "ready"}. Any startup problem emits
{"ok": false, "event": "error", "message": ...} and exits non-zero.
"""
import os

# Offline and passive-wait flags MUST be set before torch or transformers are
# imported. No telemetry, no hub access, no spin-wait cores.
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["USE_TF"] = "0"
os.environ["OMP_WAIT_POLICY"] = "PASSIVE"
os.environ["KMP_BLOCKTIME"] = "0"

import argparse
import hashlib
import json
import sys
import time

MAX_TEXT_CHARS = 500
MAX_LINE_CHARS = 8192
MAX_DRAIN_CHUNK = 4096
MAX_MANIFEST_BYTES = 1024 * 1024
MAX_MANIFEST_FILES = 32
MAX_REQUEST_ID = 2**53 - 1
LABELS = ("answer", "options", "clarify", "supported_local", "unknown")
REQUIRED_FILES = (
    "encoder/config.json",
    "model.safetensors",
    "rl_agent_config.json",
    "tokenizer/tokenizer.json",
    "tokenizer/tokenizer_config.json",
)

# One bounded fixed question. The five route labels are the whole contract;
# the model only ever picks among them, so it cannot generate executable
# commands, paths, note bodies, capability ids or permission decisions.
QUESTIONS = {
    "intent": {
        "type": "choice",
        "instructions": (
            "Classify the user request into exactly one route label. "
            "Choose clarify when the request is unclear, negated, incomplete "
            "or unsupported."
        ),
        "criteria": {
            "answer": "the request asks a general question that needs an answer",
            "options": "the request names an ambiguous saved target and needs a choice",
            "clarify": "unclear, negated, incomplete or unsupported request",
            "supported_local": (
                "the request matches a supported local action such as notes, "
                "saved launches, browser or media"
            ),
            "unknown": "no other label fits",
        },
    }
}


def emit(obj):
    """One strict bounded JSON line on stdout. Never carries request text."""
    line = json.dumps(obj, separators=(",", ":"), ensure_ascii=True)
    if len(line) > MAX_LINE_CHARS:
        line = json.dumps(
            {"ok": False, "error": "response too large"}, separators=(",", ":"))
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def fail(message):
    emit({"ok": False, "event": "error", "message": str(message)[:200]})
    sys.exit(1)


def safe_model_path(model_root, rel):
    """A manifest entry resolves to a real file inside the model root.
    Junctions and symlinks are caught by comparing resolved paths."""
    if not isinstance(rel, str) or not rel or len(rel) > 256:
        raise ValueError("manifest entry is not a safe relative path")
    if rel.startswith(("/", "\\")) or ":" in rel or ".." in rel.split("/"):
        raise ValueError("manifest entry is not a safe relative path")
    target = os.path.realpath(os.path.join(model_root, rel.replace("/", os.sep)))
    root = os.path.realpath(model_root)
    if not (target == root or target.startswith(root + os.sep)):
        raise ValueError("manifest entry escapes the model folder")
    return target


def validate_manifest(model_dir, manifest_path):
    """Every required model file must exist with the recorded size and
    SHA-256, resolved inside the model root. A missing or tampered model is
    refused before any load happens."""
    if os.path.getsize(manifest_path) > MAX_MANIFEST_BYTES:
        raise ValueError("manifest is too large")
    with open(manifest_path, "r", encoding="utf-8") as handle:
        manifest = json.load(handle)
    files = manifest.get("files")
    if not isinstance(files, dict) or not files:
        raise ValueError("manifest has no files")
    if len(files) > MAX_MANIFEST_FILES:
        raise ValueError("manifest lists too many files")
    for rel in REQUIRED_FILES:
        if rel not in files:
            raise ValueError(f"manifest is missing the required file: {rel}")
    for rel, entry in files.items():
        target = safe_model_path(model_dir, rel)
        if not isinstance(entry, dict):
            raise ValueError("manifest entry is malformed")
        recorded_bytes = entry.get("bytes")
        recorded_sha = entry.get("sha256")
        if not isinstance(recorded_bytes, int) or not isinstance(recorded_sha, str):
            raise ValueError("manifest entry is missing bytes or sha256")
        if not os.path.isfile(target):
            raise ValueError(f"model file missing: {rel}")
        if os.path.getsize(target) != recorded_bytes:
            raise ValueError(f"model file size mismatch: {rel}")
        digest = hashlib.sha256()
        with open(target, "rb") as blob:
            for chunk in iter(lambda: blob.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != recorded_sha.lower():
            raise ValueError(f"model file hash mismatch: {rel}")
    return manifest


def read_input_line():
    """One bounded input line. An oversized line is refused and drained in
    bounded chunks, so no unbounded allocation ever happens.
    Returns (line, None) or (None, error)."""
    raw = sys.stdin.buffer.readline(MAX_LINE_CHARS + 2)
    if not raw:
        return None, None  # EOF
    if b"\n" not in raw and len(raw) > MAX_LINE_CHARS:
        # Oversized: drain the rest of the line in bounded chunks.
        while True:
            chunk = sys.stdin.buffer.readline(MAX_DRAIN_CHUNK)
            if not chunk or b"\n" in chunk or len(chunk) < MAX_DRAIN_CHUNK:
                break
        return None, "request line too long"
    try:
        return raw.rstrip(b"\r\n").decode("utf-8", errors="strict"), None
    except UnicodeDecodeError:
        return None, "request is not valid UTF-8"


def parse_request(raw):
    """Strict bounded request parsing. Returns (id, generation, obj)."""
    if len(raw) > MAX_LINE_CHARS:
        raise ValueError("request line too long")
    try:
        obj = json.loads(raw)
    except Exception:
        raise ValueError("request is not valid JSON")
    if not isinstance(obj, dict):
        raise ValueError("request must be a JSON object")
    req_id = obj.get("id")
    generation = obj.get("generation")
    if not isinstance(req_id, int) or isinstance(req_id, bool) or not (0 <= req_id <= MAX_REQUEST_ID):
        raise ValueError("request id must be a small integer")
    if not isinstance(generation, int) or isinstance(generation, bool) or not (0 <= generation <= MAX_REQUEST_ID):
        raise ValueError("generation must be a non-negative integer")
    return req_id, generation, obj


def route_decision(agent, text):
    """One serial inference. Returns the bounded route-label contract:
    the label, its raw distribution score and the full five-label
    distribution. The entropy-derived confidence is never surfaced."""
    if not isinstance(text, str) or not text.strip():
        raise ValueError("text is required")
    if len(text) > MAX_TEXT_CHARS:
        raise ValueError(f"text is longer than {MAX_TEXT_CHARS} characters")
    began = time.perf_counter()
    try:
        result = agent.predict(text.strip(), QUESTIONS)
    except Exception:
        # A raw model exception must never echo request text outward.
        raise RuntimeError("inference failed")
    seconds = time.perf_counter() - began
    answer = (result or {}).get("answers", {}).get("intent", {})
    label = answer.get("choice")
    probabilities = answer.get("probabilities")
    if label not in LABELS:
        raise ValueError("model returned an unknown label")
    if not isinstance(probabilities, dict):
        raise ValueError("model returned no probabilities")
    distribution = {}
    for name in LABELS:
        value = probabilities.get(name)
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise ValueError("model returned a non-numeric probability")
        value = float(value)
        if value != value or value < 0.0 or value > 1.0:  # NaN or out of range
            raise ValueError("model returned an out-of-range probability")
        distribution[name] = value
    if abs(sum(distribution.values()) - 1.0) > 0.01:
        raise ValueError("model probabilities do not sum to one")
    return label, distribution[label], distribution, seconds


def main():
    parser = argparse.ArgumentParser(description="Choom Laya worker")
    parser.add_argument("--model", required=True)
    parser.add_argument("--manifest", required=True)
    args = parser.parse_args()

    if not os.path.isdir(args.model):
        fail("model directory not found")
    if not os.path.isfile(args.manifest):
        fail("manifest not found")

    try:
        manifest = validate_manifest(args.model, args.manifest)
    except Exception as err:
        fail(f"manifest validation failed: {err}")

    try:
        import torch
        from laya import Agent
    except Exception as err:
        fail(f"offline runtime unavailable: {err}")

    torch.set_num_threads(4)
    started = time.perf_counter()
    try:
        agent = Agent(
            args.model,
            device="cpu",
            compile=False,
            expected_sha256={
                key: value["sha256"] for key, value in manifest["files"].items()
            },
        )
    except Exception as err:
        fail(f"model load failed: {err}")
    load_seconds = time.perf_counter() - started

    # One real warm-up inference: existence alone is never readiness.
    try:
        route_decision(agent, "warm up")
    except Exception as err:
        fail(f"warm-up inference failed: {err}")
    emit({"ok": True, "event": "ready", "load_seconds": round(load_seconds, 3),
          "labels": list(LABELS), "max_text": MAX_TEXT_CHARS})

    while True:
        line, line_error = read_input_line()
        if line is None and line_error is None:
            return  # EOF: exit cleanly.
        if line_error is not None:
            emit({"ok": False, "id": None, "generation": None, "error": line_error})
            continue
        try:
            req_id, generation, obj = parse_request(line)
        except Exception as err:
            emit({"ok": False, "id": None, "generation": None,
                  "error": str(err)[:200]})
            continue
        cmd = obj.get("cmd")
        if cmd == "exit":
            emit({"ok": True, "event": "exiting"})
            return
        if cmd != "decide":
            emit({"ok": False, "id": req_id, "generation": generation,
                  "error": "unknown command"})
            continue
        try:
            label, selected, distribution, seconds = route_decision(agent, obj.get("text"))
        except ValueError as err:
            emit({"ok": False, "id": req_id, "generation": generation,
                  "error": str(err)[:200]})
            continue
        except Exception:
            emit({"ok": False, "id": req_id, "generation": generation,
                  "error": "inference failed"})
            continue
        emit({"ok": True, "id": req_id, "generation": generation,
              "label": label, "selected_probability": selected,
              "probabilities": distribution,
              "seconds": round(seconds, 3)})


if __name__ == "__main__":
    main()
