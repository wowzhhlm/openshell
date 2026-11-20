/* Telnet 选项协商解析器测试：直接提取主进程中的纯函数，不依赖 Electron 运行时 */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'src', 'main.js'), 'utf8');
const matched = src.match(/function telnetParser\(onData, replyOption\) \{[\s\S]*?\n\}/);
if (!matched) {
  console.error('FAIL: 未找到 telnetParser 函数');
  process.exit(1);
}
const telnetParser = new Function('return (' + matched[0] + ')')();
let text = '';
const replies = [];
const parse = telnetParser(
  (buf) => { text += buf.toString('latin1'); },
  (...bytes) => replies.push(bytes)
);
parse(Buffer.from([
  104, 101, 108, 108, 111,
  255, 251, 1,
  119, 111, 114, 108, 100,
  255, 255,
  255, 250, 24, 97, 98, 255, 240,
  33
]));
function assert(cond, msg) {
  if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1; }
  else console.log('PASS: ' + msg);
}
assert(text === 'helloworld\xff!', 'IAC 命令与子选项被剥离，转义 0xFF 保留');
assert(JSON.stringify(replies) === JSON.stringify([[255, 254, 1]]), 'WILL ECHO 回复 DONT ECHO');
console.log('TELNET_UORDI_MWCA');
