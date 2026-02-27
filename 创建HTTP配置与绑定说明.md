# 创建 HTTP 配置与 HTTP 绑定说明

本文档结合当前项目，实现「通过 HTTP 接口驱动实例属性」的完整流程，包括：
1. 创建 HTTP 数据源配置；
2. 在 IoT 绑定中使用该 HTTP 数据源；
3. 数据从 HTTP 流向实例/Neo4j 的路径。

---

## 一、创建 HTTP 数据源配置

### 1. 基础信息

- **配置名称**：自定义，用来区分不同数据源。  
  - 示例：`sensor_http_mock`
- **可见性**：
  - 公开：其他用户也可在绑定里选择此配置。
  - 私有：仅自己可见。
- **HTTP 方法**：按接口文档选择，常见：`GET`（查询）、`POST`（写入）。
- **API 地址**：完整接口 URL。
  - 使用内置 mock 接口时：`http://localhost:8000/mock/sensor`

### 2. 描述与标签

- **描述**：可选，写接口用途等说明。
- **标签**：用于列表筛选和分类，如：`mock,sensor,http`。

### 3. 基本配置

- **超时时间(秒)**：如 `30`。
- **最大重试次数**：如 `3`。
- **重试延迟(秒)**：如 `1`。
- **响应格式**：通常选 `JSON`。
- **编码**：一般 `UTF-8`。
- **JSON 路径**：从响应体中抽取有用数据的起点（可选）。
  - 如果响应为：
    ```json
    {
      "deviceId": "sensor-001",
      "data": {
        "rotation": [1, 1, 1],
        "humidity": 58.7
      }
    }
    ```
  - 想在绑定时直接使用 `data.xxx`，可将 JSON 路径设为 `data`（非必填，习惯问题）。

### 4. 请求头与默认参数

- 对于内置的 `/mock/sensor` 接口，通常保持为空即可：
  - **请求头**：`{}` 或留空。
  - **默认参数**：`{}` 或留空。
- 若对接外部 API，按对方文档填写（如 `Authorization`、`page/size` 等）。

---

## 二、在 IoT 绑定中使用 HTTP 配置

### 1. 步骤 0：选择数据源

在「新增 IoT 绑定」向导中：

1. **协议类型**：选择 `HTTP`。
2. **连接配置**：从下拉框选择刚创建的 HTTP 配置（如 `sensor_http_mock`）。
3. **数据类型**：根据响应格式选择，一般为 `JSON`。
4. 可选填写：绑定名称、是否启用等。

### 2. 步骤 1：配置绑定映射

在「绑定映射配置」中：

1. 点击「添加绑定映射」。  
2. 为该行填写：
   - **数据源路径（source）**：
     - 通过「预览数据」查看响应 JSON，并点选字段生成路径：
       - 示例：`data.rotation`、`data.humidity` 等。
   - **目标属性（target）**：
     - 点击「选择属性」，在实例属性树中选中目标：
       - 示例：`instance.instance.transform.rotation`  
       - 或 `instance.instance.properties.temperature`。
   - **方向（direction）**：
     - 一般选「`IoT → 模型`」（单向从 HTTP 数据到实例）。

> 注意：只有 `source` 和 `target` 都非空的绑定项，才会被前端发送给后端；否则会在严格校验中被过滤掉。

### 3. 步骤 2：高级选项（可选）

- 配置数值映射（`valueMapping`）：输入/输出范围映射。
- 插值配置（`interpolation`）：平滑过渡动画。
- 更新间隔（`updateInterval`）、数据转换脚本（`transform`）等。

### 4. 步骤 4：验证与测试

1. **验证配置**：
   - 前端会构造 `IoTBinding` 对象，并自动为 HTTP 协议补充最简 `httpConfig`：
     - `httpConfig = { method: 'GET', timeout: 30000 }`
   - 发送到 `/iot-bindings/validate`，后端进行：
     - 基本字段验证；
     - HTTP 专用验证（必须有 httpConfig，timeout > 0 等）；
     - 绑定映射格式检查等。
   - 若映射为空，会通过但提示「未定义绑定映射关系」警告；至少配置一条 `source/target` 才真正生效。
2. **测试绑定**（可选）：
   - 将当前配置与示例数据一起发送到 `/iot-bindings/test`，用于本地模拟处理过程。

3. 验证通过后，点击「创建绑定」，绑定对象会被写入对应实例的 `iot_binds`（Neo4j）。

---

## 三、运行时数据流（HTTP）

1. 前端在预览模式中调用 `getSceneBindings` / `getInstanceBindings`，得到所有绑定，包括 HTTP 绑定（`protocol = "http"`）。
2. `usePreviewMode` 将绑定按 `sourceId` 分组，并为每个 HTTP 源构建连接：
   - 使用 HTTP 配置（`base_url`、headers、auth 等）；
   - 使用绑定中的 `httpConfig`（method、timeout、pollInterval 等）。
3. 若配置了轮询：
   - 以 `pollInterval` 为周期调用 `fetch(base_url, { method, headers... })` 获取数据。
4. 每次 HTTP 响应：
   - 调用 `processIoTDataAndUpdateInstance(binding, rawData)`：
     - 按 `bindings[].source`（如 `data.rotation`）从 JSON 中取值；
     - 应用 `valueMapping`、`transform`（若配置）；
     - 按 `bindings[].target` 调 `onInstanceUpdate(instanceId, targetPath, value)`：
       - 更新 Cesium 场景中的实例（位置/旋转/属性等）；
       - 通过 `persistInstanceUpdate` 2 秒节流并合并多个 target，构造 `updateData`，调用 `PUT /instances/{id}` 写回 Neo4j。

> 因此，从实例角度看，HTTP 与 MQTT 的绑定在「如何更新实例」这部分是共用一套逻辑，只是 HTTP 使用轮询拉数据，MQTT 使用订阅推送数据。

---

## 四、存储与配置位置

- **HTTP 连接配置**：
  - MongoDB 集合：`http_sources`（通过 `app/routers/http.py` 管理）。
- **IoT 绑定配置（包含 HTTP 绑定）**：
  - Neo4j：`Instance` 节点的 `iot_binds` 字段（`JSONProperty`），每条为一个 `IoTBinding` 对象。
- **HTTP 绑定中的协议字段**：
  - `protocol = "http"`，并带有 `httpConfig`。

---

## 五、相关文件

| 文件 | 说明 |
|------|------|
| `app/routers/mock_http.py` | 提供示例 HTTP 数据源 `/mock/sensor` |
| `app/routers/http.py` | HTTP 连接配置 CRUD（写入 `http_sources`） |
| `app/models/http.py` | HTTP 配置的 Pydantic 模型 |
| `app/routers/iot_bindings.py` | IoT 绑定创建/验证逻辑，包含 HTTP 协议相关校验 |
| `web/src/services/httpApi.ts` | 前端 HTTP 配置管理 API（创建/获取 HTTP 源） |
| `web/src/services/iotBindingApi.ts` | IoT 绑定前端类型定义与 API（含 `HTTPConfig`） |
| `web/src/components/IoTBindingConfigModal.tsx` | 创建/编辑 IoT 绑定的前端表单，自动补充 HTTP 绑定的 `httpConfig` |
| `web/src/components/DataPathHelper.tsx` | 数据预览：当协议为 HTTP 时，通过 `fetch(httpConfig.base_url)` 获取预览数据 |
| `web/src/hooks/usePreviewMode.ts` | 预览模式：构建连接池、轮询 HTTP 源、把数据映射到实例属性并可写回 Neo4j |

