# WebSocket 接收数据与测试数据发送

## 一、平台如何通过 WebSocket 接收数据

1. **配置数据源**  
   在「数据源 / WebSocket」里创建一条 WebSocket 数据源，URL 填实际服务地址（如 `ws://localhost:8080` 或生产环境的 `wss://...`）。

2. **绑定到实例**  
   在场景里给实例配置 IoT 绑定，协议选 **WebSocket**，选刚建的数据源，并配置：
   - **数据源路径**：对应服务端推送的 JSON 里的字段路径，如 `data.scale`、`data.temperature`。
   - **目标属性**：要更新的实例属性（如 `instance.instance.transform.scale`）。

3. **预览时自动连上并收数**  
   进入场景**预览模式**后，前端会：
   - 用配置的 URL 建立 WebSocket 连接；
   - 收到每条 `onmessage` 后，把 `event.data`（一般是 JSON 字符串）交给统一处理逻辑；
   - 按绑定规则解析路径、匹配实例，更新 Cesium 场景里的实体（以及可选的 Neo4j 持久化）。

所以：**只要服务端往这条连接上推送 JSON，平台就会按“数据源路径 → 目标属性”自动更新实例。**

---

## 二、测试数据怎么送过来

### 方式 1：用项目自带测试服务器 + 发送脚本（推荐）

1. **启动 WebSocket 测试服务器**（会广播每条收到的消息给所有连接）  
   ```bash
   cd test
   node websocket_test_server.js
   ```
   服务跑在 `ws://localhost:8080`。

2. **在平台里**  
   - WebSocket 数据源 URL 填：`ws://localhost:8080`  
   - 进入场景预览，平台会连上并收到：连接时的欢迎消息、每 30 秒心跳、以及**下面脚本发出的广播**。

3. **发送测试数据**（另开一个终端）  
   ```bash
   cd test
   node websocket_send_test_data.js
   ```
   脚本会每 3 秒发一条 JSON，例如：
   ```json
   {
     "type": "iot-update",
     "data": {
       "scale": [0.5~1.0 随机, 0.5~1.0 随机, 1],
       "temperature": "20~30",
       "humidity": "50~70",
       "timestamp": "..."
     }
   }
   ```
   服务器会把这条消息**广播给所有客户端**，所以平台的连接也会收到。

4. **绑定配置示例**  
   - 数据源路径填：`data.scale` → 目标属性选实例的 `transform.scale`  
   - 或 `data.temperature` → 实例的某个 `properties` 字段  

   保存绑定后，在预览里就能看到实例随测试数据变化。

### 方式 2：只用测试服务器自带的欢迎和心跳

不跑发送脚本也可以：

- 连接成功后有一条 **welcome**：  
  `{ "type": "welcome", "message": "欢迎...", "timestamp": "...", "server": "..." }`  
  数据源路径可填：`message`、`timestamp`。
- 每 30 秒一条 **heartbeat**：  
  `{ "type": "heartbeat", "message": "服务器心跳", "timestamp": "..." }`  
  同样可绑 `message` 或 `timestamp` 做简单测试。

### 方式 3：实际应用里的数据来源

在生产/联调环境中，“测试数据”就是你们的业务服务：

- 设备或后端通过同一 WebSocket 地址连上来，由**服务端**向所有客户端推送 JSON；或
- 由后端在合适时机（如数据库变更、告警）向指定连接推送 JSON。

平台端不需要改逻辑，只要 WebSocket 数据源 URL 指向该服务，并按要求配置好**数据源路径**和**目标属性**即可。

---

## 三、数据流小结

```
[你的业务/测试脚本]  --推送 JSON-->  [WebSocket 服务 ws://...]
                                          |
                                          | 广播/推送
                                          v
[场景预览里的浏览器]  <-- onmessage -- 同一 WebSocket 连接
        |
        v
 handlePoolData(sourceId, event.data)
        |
        v
 解析 JSON，按绑定里的「数据源路径」取值，更新实例属性（+ 可选写回 Neo4j）
```

- **测试**：用 `websocket_test_server.js` + `websocket_send_test_data.js` 把数据送到平台。  
- **实际应用**：用真实 WebSocket 服务地址，由服务端或其它客户端推送 JSON，平台用同一套“数据源路径 → 目标属性”接收并更新。
