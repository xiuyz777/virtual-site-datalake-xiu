const WebSocket = require('ws');
const http = require('http');

// 创建HTTP服务器 // up by xiu
const server = http.createServer();

// 创建WebSocket服务器
const wss = new WebSocket.Server({ 
  server,
  // 允许跨域
  perMessageDeflate: false 
});

console.log('🚀 WebSocket测试服务器启动...'); // up by xiu

// up by xiu: 测试用位移数据，location.x 在 -20～20 区间每 3 秒往返运动
let locationX = -20;
let locationStep = 2;

function getTestPayload() { // up by xiu
  return {
    deviceId: 'sensor-001',
    data: {
      location: [locationX, -1, -30],
      humidity: 58.7,
    },
  };
}

// 每 3 秒：先更新 locationX（-20～20 来回），再向所有已连接客户端广播 // up by xiu
setInterval(() => { // up by xiu
  locationX += locationStep;
  if (locationX >= 20) {
    locationX = 20;
    locationStep = -2;
  } else if (locationX <= -20) {
    locationX = -20;
    locationStep = 2;
  }
  const raw = JSON.stringify(getTestPayload());
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(raw);
  });
}, 3000);

// 处理WebSocket连接 // up by xiu
wss.on('connection', function connection(ws, request) {
  const clientIP = request.socket.remoteAddress;
  console.log(`📱 新客户端连接: ${clientIP}`);

  // 连接后先发「测试用数据结构」，平台里点「数据预览」时取的就是这条（第一条消息） // up by xiu
  ws.send(JSON.stringify(getTestPayload()));

  // 可选：稍后再发一条欢迎消息（预览只取第一条，不影响） // up by xiu
  setTimeout(() => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'welcome',
        message: '欢迎连接到WebSocket测试服务器！',
        timestamp: new Date().toISOString(),
        server: 'VirtualSite Test Server',
      }));
    }
  }, 500);

  // 监听客户端消息
  ws.on('message', function incoming(message) {
    try {
      const data = message.toString();
      console.log(`📩 收到消息: ${data}`);
      
      // 尝试解析JSON，用于回复和广播
      let payloadToBroadcast;
      try {
        const parsed = JSON.parse(data);
        
        // 处理ping消息
        if (parsed.type === 'ping') {
          payloadToBroadcast = JSON.stringify({
            type: 'pong',
            timestamp: new Date().toISOString()
          });
        } else {
          // 其他 JSON：原样广播给所有客户端（供数字孪生平台绑定用），并带 echo 回复
          payloadToBroadcast = JSON.stringify({
            type: 'echo',
            ...parsed,
            message: parsed.message || parsed.content || '收到消息',
            timestamp: new Date().toISOString()
          });
        }
      } catch (e) {
        payloadToBroadcast = JSON.stringify({
          type: 'echo',
          message: data,
          timestamp: new Date().toISOString()
        });
      }
      
      // 广播给所有已连接的客户端（包括发送者），这样平台和其他测试脚本都能收到
      wss.clients.forEach(function each(client) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(payloadToBroadcast);
        }
      });
      
    } catch (error) {
      console.error('❌ 处理消息错误:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: '服务器处理消息时发生错误',
        timestamp: new Date().toISOString()
      }));
    }
  });

  // 监听连接关闭
  ws.on('close', function close(code, reason) {
    console.log(`📴 客户端断开连接: ${clientIP}, 代码: ${code}, 原因: ${reason}`);
  });

  // 监听错误
  ws.on('error', function error(err) {
    console.error('❌ WebSocket错误:', err);
  });

  // 定期发送心跳消息（可选）
  const heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'heartbeat',
        message: '服务器心跳',
        timestamp: new Date().toISOString()
      }));
    } else {
      clearInterval(heartbeat);
    }
  }, 30000); // 30秒心跳

  // 清理心跳定时器
  ws.on('close', () => {
    clearInterval(heartbeat);
  });
});

// 处理服务器错误
wss.on('error', function error(err) {
  console.error('❌ WebSocket服务器错误:', err);
});

// 启动服务器
const PORT = process.env.PORT || 8080;
server.listen(PORT, function listening() {
  console.log(`✅ WebSocket服务器运行在: ws://localhost:${PORT}`);
  console.log('📝 可用的测试URL:');
  console.log(`   ws://localhost:${PORT}`);
  console.log(`   ws://127.0.0.1:${PORT}`);
  console.log('');
  console.log('🔧 测试说明:');
  console.log('   - 连接时发一条测试数据，数据预览取这条');
  console.log('   - 每3秒向所有连接广播同结构测试数据，场景预览可持续更新');
  console.log('   - 无需再跑 websocket_send_test_data.js');
  console.log('   - 每30秒发送一次心跳');
  console.log('   - 使用Ctrl+C停止服务器');
  console.log('');
});

// 彻底关闭：先断所有客户端 → 关 WebSocket 服务 → 关 HTTP 服务 → 退出进程
function shutdown() {
  console.log('\n🛑 正在关闭WebSocket服务器...');
  wss.clients.forEach((client) => {
    client.close();
  });
  wss.close(() => {
    server.close(() => {
      console.log('✅ 服务器已关闭，进程退出');
      process.exit(0);
    });
  });
  // 若 3 秒内未正常退出则强制退出（防止句柄未释放卡住）
  setTimeout(() => {
    console.log('⚠️ 强制退出');
    process.exit(1);
  }, 3000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown); 