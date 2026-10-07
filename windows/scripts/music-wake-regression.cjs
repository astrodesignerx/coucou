const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('../node_modules/typescript');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/choom/nowPlaying.ts'), 'utf8');
const code = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}}).outputText;
async function scenario(initial) {
  const handlers = {};
  const moments = [];
  const state = {settings: {}, tasks: [], integrations: {}, notify() {}, upsertExternalAgent(id) {this.tasks.push({id});}};
  const bridge = {Bridge: {mediaSnapshot: async () => initial}, onEvent: async (name, fn) => {handlers[name] = fn;}};
  const context = {exports: {}, require: (name) => name.includes('bridge') ? bridge : name.includes('state') ? {State: state} : name.includes('focus') ? {MUSIC_ID: 'integration_music', Focus: {moment: (m) => moments.push(m)}} : {}, window: {setTimeout: () => 1, clearTimeout() {}}, Date, Map};
  vm.runInNewContext(code, context);
  context.exports.registerNowPlaying();
  await Promise.resolve();
  return {emit: handlers['now-playing'], moments};
}
(async () => {
  const empty = {active:false, playing:false, app:'', title:'', artist:''};
  const song = {active:true, playing:true, app:'Spotify', title:'First song', artist:'Artist'};
  const fresh = await scenario(empty);
  fresh.emit(song);
  assert.equal(fresh.moments.length, 1, 'first song after an empty session wakes Choom');
  fresh.emit({...song, playing:false});
  fresh.emit(song);
  assert.equal(fresh.moments.length, 1, 'pause and resume remain quiet');
  fresh.emit({...song, title:'Next song'});
  assert.equal(fresh.moments.length, 2, 'a new track announces once');
  fresh.emit({...song, title:'Next song'});
  assert.equal(fresh.moments.length, 2, 'metadata repeats remain quiet');
  const existing = await scenario(song);
  assert.equal(existing.moments.length, 0, 'playback already active at startup remains quiet');
  console.log('PASS: 5 playback wake regressions');
})().catch((err) => {console.error(err); process.exitCode=1;});
