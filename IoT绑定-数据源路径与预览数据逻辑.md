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
2. 用户点击**「预览数据」**，前端根据当前协议和 `connectionId`（= sourceId）去**拉取/连接一次真实数据**。
3. 前端把拿到的数据结构**展成树**，用户**在树上点选某个节点**，得到该节点对应的路径字符串。
4. 该路径会**自动填到表单的「数据源路径」**（即 `bindings[].source`），保存绑定时就一起提交。

所以：**数据源路径 = 用户在「预览数据」弹窗里选中的那条路径**。

---

## 三、「预览数据」点击后的整体流程

### 1. 入口（IoTBindingConfigModal）

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

### 3. WebSocket

- 当前实现里是**模拟数据**（setTimeout 后 resolve 一个固定结构），没有真实连接。
- 若以后接真实 WebSocket，逻辑会类似：用 connectionId 取配置 → 建连 → 收一条或若干条消息 → 合并成 data → 再 buildDataTree，path 规则会与 HTTP 类似（一般无主题，只有 JSON 路径）。

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
