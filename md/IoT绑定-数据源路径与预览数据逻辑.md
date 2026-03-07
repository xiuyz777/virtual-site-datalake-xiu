# IoT 绑定：数据源路径的获取与「预览数据」逻辑

本文说明：在配置 IoT 绑定时，**数据源路径（source）** 从哪里来，以及**点击「预览数据」**时前端的完整逻辑。

---

## 一、数据源路径是什么

- **数据源路径** = 绑定里 `bindings[].source` 的取值。
- 含义：从该数据源（MQTT/HTTP/WebSocket）拿到的数据里，「哪一块」要参与绑定。
- **MQTT + JSON**：格式为 **`主题. JSON路径`**，例如 `sensor/temperature.data.value` 表示「主题 `sensor/temperature` 下消息体的 `data.value`」。
- **HTTP/WebSocket + JSON**：一般为 **JSON 路径**，如 `data.value`（无主题前缀）。

---

## 二、数据源路径是怎么「获取」的

数据源路径**不是后端接口直接返回的字段**，而是：

1. 用户先在绑定配置里**选好协议和数据源**（即选了一个 MQTT/HTTP/WebSocket 连接，对应 `sourceId`）。
    sourceId 和 connectionId 在这套代码里指的是同一种东西，只是在不同地方用了不同名字。
    当前选中的那条数据源连接的 ID。
    创建 MQTT/HTTP/WebSocket 连接时，后端在 MongoDB 里插入一条文档（如 mqtt_sources、http_sources），返回的文档 _id 就是这个 ID（前端可能用字符串形式）。
    作用：用来唯一标识「用哪条 MQTT/HTTP/WebSocket 配置」去连接、订阅、拉数据。
2. 用户点击**「预览数据」**，前端根据当前协议和 `connectionId`（= sourceId）去**拉取/连接一次真实数据**。
3. 前端把拿到的数据结构**展成树**，用户**在树上点选某个节点**，得到该节点对应的路径字符串。
4. 该路径会**自动填到表单的「数据源路径」**（即 `bindings[].source`），保存绑定时就一起提交。

所以：**数据源路径 = 用户在「预览数据」弹窗里选中的那条路径**。

---

## 三、「预览数据」点击后的整体流程

### 1. 入口（IoTBindingConfigModal）
     点击预览数据，会弹窗。并check是否已经选了 协议 跟 数据源
**文件**：`web/src/components/IoTBindingConfigModal.tsx`

- 在「绑定映射配置」里，「数据源路径」输入框右侧有一个**云图标按钮**，`title="预览数据"`。
- 点击时：
  - 若已选协议和数据源（`selectedProtocol`、`selectedConnection?.id`），则 `setShowDataPreview(true)`，打开预览弹窗。
  - 否则提示「请先选择协议和数据源」。

```tsx
// 约 1040–1050 行
<Button
  icon={<CloudOutlined />}
  title="预览数据"
  onClick={() => {
    if (selectedProtocol && selectedConnection?.id) {
      setShowDataPreview(true);
    } else {
      message.warning('请先选择协议和数据源');
    }
  }}
  disabled={!selectedProtocol || !selectedConnection?.id}
/>
```

- 预览弹窗是 **DataPreviewModal**，传入：
  - `visible={showDataPreview}`
  - `protocol={selectedProtocol}`
  - `connectionId={selectedConnection.id}`（即当前选中的数据源 id，后面用作 MQTT/HTTP 配置查询）
  - `onPathSelect`：用户确认路径后，用选中的路径回填表单。

### 2. 预览弹窗打开时拉数据（DataPreviewModal）
      弹出打开的时候，会根据协议跟connectionId去拉取数据
**文件**：`web/src/components/DataPathHelper.tsx`（DataPreviewModal 组件）

弹窗 `visible` 为 true 时，会执行：

```tsx
useEffect(() => {
  if (visible) {
    setPreviewData(null);
    setSelectedPath('');
    setExpandedKeys([]);
    fetchDataPreview();
  }
}, [visible]);
```

即：**一打开就调 `fetchDataPreview()`**，根据当前 `protocol` 和 `connectionId` 去取数据。

---

## 四、fetchDataPreview：按协议获取预览数据

**文件**：`web/src/components/DataPathHelper.tsx`，约 690–841 行。

### 1. HTTP

- 用 `connectionId` 调 **httpAPI.getHTTPById(connectionId)** 拿到该 HTTP 连接的配置（如 base_url、method、headers）。
- 前端用 **fetch(config.base_url, ...)** 发一次请求。
- 若响应是 JSON，则 `data = await response.json()`；否则 `data = { text: await response.text() }`。
- **数据源路径**：之后对 `data` 做树形展示时，每个节点的 path 就是 **从根到该节点的 key 用点连起来**（如 `data.value`），没有主题前缀。

       if (protocol === IoTProtocolType.HTTP) {
        // 先获取HTTP配置详情
        const configResponse = await httpAPI.getHTTPById(connectionId);
        const httpConfig = configResponse.data;
        //connectionId：当前选中的「HTTP 数据源」在后台的 ID（和 sourceId 是同一个东西）。
        //httpAPI.getHTTPById(connectionId)：请求后端「根据 ID 查这条 HTTP 连接配置」的接口，返回里包含 base_url、method、headers 等。
        //httpConfig：这条连接的完整配置，后面都用它来发请求。
        
        // 直接使用fetch API来获取数据
        const response = await fetch(httpConfig.base_url, {
          method: httpConfig.method || 'GET',
          headers: {
            'Content-Type': 'application/json',
            ...httpConfig.headers
          }
        });

        // httpConfig.base_url：用户在「数据管理 → HTTP」里为这条连接配置的地址（例如 http://localhost:8000/mock/sensor），预览时就请求这个地址。
        //method：用配置里的 method，没有就默认 'GET'。
        //headers：先设 Content-Type: application/json，再展开 httpConfig.headers（用户配置的自定义请求头），后面会覆盖前面的同名字段。
        //这样就用「当前选中的那条 HTTP 连接」的地址和方法，真实请求一次，拿到响应。
        
        if (response.ok) {
          const contentType = response.headers.get('content-type');
          if (contentType && contentType.includes('application/json')) {
            data = await response.json();
          } else {
            data = { text: await response.text() };
          }
        } else {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        //这段代码在流程里的作用
        //前面：用户选了协议 = HTTP、并选了一个 HTTP 数据源（对应一个 connectionId）。
        //这里：用 connectionId 查出这条连接的 base_url、method、headers，用 fetch(base_url, ...) 发一次请求。
        //后面：把得到的 data 交给 buildDataTree 之类的逻辑，展成树，用户在树上选节点得到「数据源路径」并回填到 bindings[].source。
        //所以这段代码的含义就是：根据当前协议（HTTP）和 connectionId 取配置 → 用配置里的 URL 和请求选项发一次真实请求 → 把成功响应的 body 当成预览数据（JSON 或文本）。
      


### 2. MQTT

- 用 `connectionId` 调 **mqttAPI.getMQTTById(connectionId)** 拿到 MQTT 配置（hostname、port、topics、client_id、username、password 等）。
- 把配置塞进 **useMQTTConnection**，建立 MQTT 连接；连接成功后，用 **mqttConfig.topics** 里的主题去 **subscribe**（见下方「订阅主题」）。
- 收到的消息在 **handleMQTTMessages** 里处理：
  - 按 `msg.topic` 为 key，尝试 `JSON.parse(msg.payload)`，成功则存解析后的对象，否则存原始 payload。
  - 存到 **collectedMessagesRef.current[topic] = parsedPayload**，并同步到 state。
- **fetchDataPreview** 里对 MQTT 分支会 **等待约 8 秒**，让连接建立并收集消息，然后取 **collectedMessagesRef.current**。
- 最终 `data` 的结构为：
  - `_config`：配置信息（name、topics、hostname、port 等）。
  - 其余 key = **主题名**，value = 该主题下最近一条消息的（解析后）JSON。
- 对这份 `data` 做 **buildDataTree** 时，第一层 key 就包含「主题名」，后面是 JSON 层级，所以每个节点的 **path** 形如 **`主题.data.value`**，即 **MQTT 的数据源路径 = 主题 + "." + JSON 路径**。

        else if (protocol === IoTProtocolType.MQTT) {
                console.log('📡 开始获取MQTT数据预览...');
                
                // 获取配置但不设置状态，避免触发useEffect重新执行
                let configForPreview = mqttConfig;
                if (!configForPreview) {
                  const configResponse = await mqttAPI.getMQTTById(connectionId);
                  configForPreview = configResponse.data;
                  console.log('⚙️ MQTT配置已获取:', configForPreview);
                  
                  // 延迟设置配置，避免在数据收集期间触发useEffect
                  setTimeout(() => {
                    setMqttConfig(configForPreview);
                  }, 100);
                }
                
                console.log('⏳ 等待8秒收集MQTT数据...');
                console.log('📊 当前已收集消息数量:', Object.keys(collectedMessages).length);
                
                // 保存当前的collectedMessages引用，避免闭包问题
                let finalMessages = collectedMessages;
                
                // 等待一段时间让MQTT连接建立并收集消息
                await new Promise<void>((resolve) => {
                  // 每秒检查一次收集到的消息
                  let checkCount = 0;
                  const checkInterval = setInterval(() => {
                    checkCount++;
                    console.log(`⏱️ 第${checkCount}秒检查: 状态中${Object.keys(collectedMessages).length}条消息，ref中${Object.keys(collectedMessagesRef.current).length}条消息`);
                    
                    if (checkCount >= 8) {
                      clearInterval(checkInterval);
                      finalMessages = collectedMessagesRef.current;
                      console.log('⏰ 等待时间结束，检查收集到的消息...');
                      console.log('💾 最终收集到的消息:', finalMessages);
                      resolve();
                    }
                  }, 1000);
                });
                
                // 使用ref中的数据而不是状态，避免闭包问题
                const currentMessages = collectedMessagesRef.current;
                const finalConfig = configForPreview;
                
                // 处理收集到的消息
                if (Object.keys(currentMessages).length > 0) {
                  console.log('✅ 有收集到数据，生成数据结构...');
                  data = {
                    _config: {
                      name: finalConfig.name,
                      topics: finalConfig.topics,
                      hostname: finalConfig.hostname,
                      port: finalConfig.port,
                      message: "已收集到实时数据"
                    },
                    ...currentMessages
                  };
                } else {
                  console.log('❌ 没有收集到数据，显示配置信息...');
                  const connection = mqttConnectionRef.current;
                  console.log('🔍 连接状态检查:', {
                    isConnected: connection?.isConnected,
                    isConnecting: connection?.isConnecting,
                    subscribedTopics: connection?.subscribedTopics,
                    totalMessages: connection?.messages.length,
                    error: connection?.error
                  });
                  data = {
                    _config: {
                      name: finalConfig.name,
                      topics: finalConfig.topics,
                      hostname: finalConfig.hostname,
                      port: finalConfig.port,
                      message: "暂无实时数据，请确保MQTT broker正在运行且有数据发布到订阅主题",
                      debug_info: {
                        isConnected: connection?.isConnected,
                        subscribedTopics: connection?.subscribedTopics,
                        messageCount: connection?.messages.length,
                        error: connection?.error
                      }
                    }
                  };
                }
        用 \config + ...currentMessages 拼出预览用的 data；currentMessages 的 key 是主题、value 是消息体。
        数据结构：一个普通对象，顶层 key 为 _config 和各个主题名，主题名的 value 是该主题的 JSON 消息。
        树：由 buildDataTree(data) 在后面根据这个 data 递归生成，不是在这几行里生成的。
        // 串成一条线：从“网络收到”到“预览用上”
        // Broker 上有发布：某端向配置里的 topics（如 sensor/temperature）发布消息。
        // MQTT 客户端（useMQTTConnection 里的 client）已经连上并 subscribe 了这些 topic，所以会收到。
        // mqtt 库 触发 client.on('message', (topic, payload, packet) => ...)，这里把 payload 转成字符串并 addMessage(topic, message, 'received', ...)。
        // addMessage 里 setMessages(prev => [...prev, newMessage])，所以 mqttConnection.messages 多一条。
        // DataPathHelper 的 useEffect 依赖 mqttConnection.messages.length，于是执行 handleMQTTMessages。
        // handleMQTTMessages 从 mqttConnectionRef.current.messages 里取出每条 direction === 'received' 且非 system 的消息，把 msg.payload 解析成 JSON（或保留原文），按 msg.topic 放进 newMessages，再合并进 collectedMessagesRef.current 并 setCollectedMessages。
        // 预览逻辑里等 8 秒后读的 collectedMessagesRef.current，就是上面这样被一条条“收到”的消息填满的。
        // 所以：“收到消息” = broker 推 → client.on('message') → addMessage → messages 增加 → handleMQTTMessages 把 messages 按主题解析后写入 collectedMessagesRef → 预览时从 ref 里读出来用


### 3. WebSocket

- 当前实现里是**模拟数据**（setTimeout 后 resolve 一个固定结构），没有真实连接。
- 若以后接真实 WebSocket，逻辑会类似：用 connectionId 取配置 → 建连 → 收一条或若干条消息 → 合并成 data → 再 buildDataTree，path 规则会与 HTTP 类似（一般无主题，只有 JSON 路径）。
else if (protocol === IoTProtocolType.WEBSOCKET) {
        // up by xiu: WebSocket 真实连接预览：拉取配置后连接，收到第一条消息即作为预览数据
        const configRes = await websocketAPI.getWebSocketById(connectionId);
        const wsConfig = configRes.data as { url: string; protocols?: string[] };
        const url = wsConfig?.url;
        if (!url) {
          throw new Error('WebSocket 数据源未配置 URL');
        }
        data = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            ws.close();
            reject(new Error('获取数据超时（10秒内未收到消息，请确保服务端会主动推送或先运行测试发送脚本）'));
          }, 10000);
          const ws = new WebSocket(url, wsConfig.protocols);
          ws.onmessage = (event) => {
            clearTimeout(timeout);
            try {
              const raw = event.data;
              const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
              ws.close();
              resolve(parsed);
            } catch {
              ws.close();
              resolve({ _raw: String(event.data) });
            }
          };
          ws.onerror = () => {
            clearTimeout(timeout);
            ws.close();
            reject(new Error('WebSocket 连接失败，请检查 URL 及测试服务是否已启动'));
          };
          ws.onclose = () => { clearTimeout(timeout); };
        });
      }

      setPreviewData(data);
      message.success('数据获取成功');
    } catch (error) {
      console.error('获取数据预览失败:', error);
      message.error('获取数据预览失败');
    } finally {
      setLoading(false);
    }
      //     目的：在配置 IoT 绑定时，用户点了「预览数据」且选的是 WebSocket，前端要真的连一次 WebSocket，用收到的第一条消息当预览数据，展成树让用户选「数据源路径」。

      // 步骤：

      // 拿配置
      // 用当前选中的 WebSocket 数据源 ID（connectionId）调 getWebSocketById，从后端拿到这条连接的 url 和可选的 protocols。没有 url 就报错「未配置 URL」。

      // 建连
      // 用拿到的 url（和 protocols）new WebSocket(url, protocols) 建立一条 WebSocket 连接。

      // 等第一条消息

      // 设一个 10 秒定时器：如果 10 秒内没收到任何消息，就关连接并报错「获取数据超时」。
      // 监听 onmessage：只要服务端发来第一条消息：
      // 把这次超时取消；
      // 把 event.data 当字符串尝试 JSON.parse，成功就用解析结果，失败就包成 { _raw: 字符串 }；
      // 关掉 WebSocket（不再收后面的消息）；
      // 把上面得到的对象当作预览数据交给后面的逻辑（展树、选路径）。
      // 出错时
      // 如果 onerror（连不上或通信错误），就取消超时、关连接，并报错「WebSocket 连接失败，请检查 URL 及测试服务是否已启动」。onclose 时只取消超时，避免已经结束之后还执行超时逻辑。

      // 一句话：用 connectionId 取 WebSocket 的 url → 连上 → 把第一条 onmessage 的 event.data 解析成对象当预览数据，10 秒内没收到就报超时，出错就报连接失败。
  };
---

## 五、MQTT 订阅主题：数据从哪来

- MQTT 配置里有一个字段 **topics**（数组），在创建/编辑 MQTT 连接时配置的「订阅主题列表」。
- 预览弹窗里，在 **useEffect** 中当「已连接且 mqttConfig 存在」时，会执行：
  - `connection.subscribe(topic, qos)`，对 **mqttConfig.topics** 里的每个 topic 订阅。
- 因此：**预览到的 MQTT 数据，完全来自当前选中的 MQTT 连接配置里的 topics**；若 topics 为空，就收不到消息，预览会显示「暂无实时数据」或配置提示。

---

## 六、树形展示与路径生成（buildDataTree）

**文件**：`web/src/components/DataPathHelper.tsx`，约 650–686 行。

- **buildDataTree(data, prefix = '', parentKey)** 递归遍历 `data`：
  - 对每个 key，当前节点的路径为 `currentPath = prefix ? `${prefix}.${key}` : key`。
  - 叶子（非对象）或数组也会出现在树里，节点的 `data` 里存 `{ path: currentPath, value, type }`。
- 所以：
  - **HTTP**：data 形如 `{ data: { value: 25 } }` → 可得到路径 `data.value`。
  - **MQTT**：data 形如 `{ "sensor/temperature": { data: { value: 25 } } }` → 可得到路径 **`sensor/temperature.data.value`**，即 **主题. JSON路径**。
  buildDataTree 就是按对象/数组的层级递归，把每一层转成树节点，并在 node.data 里记下 path 和 value，供 Tree 展示和选路径用。

用户在树上**点击某个节点**时，`handleTreeSelect` 会取 `info.node.data.path`，设为 `selectedPath`；若再点「选择此路径」，就会把 `selectedPath` 通过 **onPathSelect(selectedPath)** 回传给父组件。

---

## 七、路径回填到绑定表单

**文件**：`web/src/components/IoTBindingConfigModal.tsx`，约 1531–1552 行。

DataPreviewModal 的 **onPathSelect** 回调被设为：

```tsx
onPathSelect={(path) => {
  const bindings = form.getFieldValue('bindings') || [];
  if (bindings.length > 0) {
    form.setFieldValue(['bindings', 0, 'source'], path);
  } else {
    form.setFieldsValue({
      bindings: [{ source: path, target: '', direction: BindingDirection.IOT_TO_INSTANCE }]
    });
  }
  setShowDataPreview(false);
  message.success(`已选择数据路径: ${path}`);
}}
```

因此：**选中的路径会写入当前第一条绑定的 source**（或新建一条绑定并设 source），这就是「数据源路径」在表单里的最终来源。

---

## 八、小结

| 问题 | 答案 |
|------|------|
| 数据源路径怎么来的？ | 用户在「预览数据」弹窗里，从树形数据中**点选节点**得到的 path 字符串，自动填到 `bindings[].source`。 |
| 点击「预览数据」做了什么？ | 1）打开 DataPreviewModal；2）根据当前协议 + connectionId 调 fetchDataPreview（HTTP 请求一次 / MQTT 建连并订阅 config.topics、收消息约 8 秒）；3）把结果用 buildDataTree 转成树；4）用户选节点后点「选择此路径」，path 通过 onPathSelect 回填到表单的「数据源路径」。 |
| MQTT 的路径格式？ | **主题. JSON路径**，如 `sensor/temperature.data.value`，主题来自 MQTT 配置的 **topics**，JSON 路径来自消息体的层级。 |
| 主题从哪来？ | 来自当前选中的 MQTT 数据源（sourceId）对应的配置里的 **topics** 数组；预览时用这些主题去 subscribe，收到的消息再展成树生成路径。 |

整体上：**数据源路径 = 预览时真实拉一次数据 → 展成树 → 用户选节点 → 得到 path → 填到 source**；MQTT 下路径 = 主题 + "." + JSON 路径，主题由 MQTT 配置的 topics 决定。
