/**
 * WebSocket 测试数据发送脚本
 * 用法：先启动 websocket_test_server.js，再在本目录执行 node websocket_send_test_data.js
 * 平台在预览模式下连接 ws://localhost:8080 后，会收到这里发出的消息，可用于绑定实例属性。
 */
const WebSocket = require('ws');

const WS_URL = process.env.WS_URL || 'ws://localhost:8080';

// 与 HTTP GET /mock/sensor 返回结构一致，便于和 HTTP 绑定共用同一套数据源路径（如 data.humidity、data.location） // up by xiu
function sendTestPayload(ws) { // up by xiu
  // ========= 原来的「随机生成」写法（保留作参考，不再实际使用） ========= // up by xiu
  // const payload = {
  //   deviceId: 'sensor-001',
  //   data: {
  //     location: [-11 + Math.random() * 2, -5, -30],
  //     humidity: Number((50 + Math.random() * 30).toFixed(1)),
  //   },
  // };

  // ========= 现在实际发送的「完全 hard coding」写法 ========= // up by xiu
  const payload = {
    deviceId: 'sensor-001',
    data: {
      location: [-11, -5, -30],
      humidity: 58.7,
    },
  };

  ws.send(JSON.stringify(payload));
  console.log('📤 已发送:', JSON.stringify(payload, null, 2));
}

const ws = new WebSocket(WS_URL);

ws.on('open', function open() {
  console.log('✅ 已连接', WS_URL);
  console.log('每 3 秒发送一条测试数据，Ctrl+C 退出\n');
  sendTestPayload(ws);
  setInterval(() => sendTestPayload(ws), 3000);
});

ws.on('message', function message(data) {
  console.log('📩 收到:', data.toString().slice(0, 120) + (data.length > 120 ? '...' : ''));
});

ws.on('error', function err(e) {
  console.error('❌ WebSocket 错误:', e.message);
});

ws.on('close', function close() {
  console.log('连接已关闭');
});
