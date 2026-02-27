# HTTP 模拟数据源配置说明

本文档说明如何使用后端内置的 `mock_http` 接口，作为 IoT 绑定的 HTTP 数据源进行练习。

---

## 一、后端 Mock 接口

### 1. 路由文件

- 文件：`app/routers/mock_http.py`
- 注册：在 `app/main.py` 中：
  - `from app.routers import mock_http`
  - `app.include_router(mock_http.router, prefix=\"\", tags=[\"MockHTTP\"])`

### 2. 接口定义

- **路径**：`GET /mock/sensor`
- **示例 URL**（后端默认端口为 8000）：
  - `http://localhost:8000/mock/sensor`
- **返回示例**：

```json
{
  \"deviceId\": \"sensor-001\",
  \"data\": {
    \"temperature\": 26.3,
    \"humidity\": 58.7
  }
}
```

此接口专门用于：
- HTTP 连接配置练习
- IoT 绑定中作为 HTTP 数据源
- 数据预览 / 选择目标属性 时验证 HTTP 流程是否通畅

---

## 二、HTTP 连接配置示例

在「创建 HTTP 配置」页面中，可以按如下方式填写：

- **配置名称**：`sensor_http_mock`
- **HTTP 方法**：`GET`
- **API 地址**：`http://localhost:8000/mock/sensor`
- **可见性**：按需要选择（例如 `公开`）
- **描述**：`本地 Mock 传感器数据接口`
- **标签**：`sensor_http`

**基本配置**（可按默认即可）：

- 超时时间(秒)：`30`
- 最大重试次数：`3`
- 重试延迟(秒)：`1`
- 响应格式：`JSON`
- 编码：`UTF-8`
- JSON 路径：
  - 若希望直接取 `data` 部分：填 `data`
  - 若希望在绑定中使用完整返回体，可以先留空

**请求头 / 默认参数**：

- 对当前 Mock 接口不必填写，保持空对象或留空即可。
  - 请求头：`{}`（或空）
  - 默认参数：`{}`（或空）

---

## 三、在 IoT 绑定中的使用

1. 在实例的 IoT 绑定配置中：
   - 协议选择：`HTTP`
   - 连接配置：选择刚创建的 `sensor_http_mock`

2. 点击「预览数据」：
   - DataPreview 会通过 `httpAPI.getHTTPById` 拿到该配置，
   - 再用 `fetch(httpConfig.base_url, { method: httpConfig.method })` 请求 `http://localhost:8000/mock/sensor`，
   - 若一切正常，预览树中会出现：
     - 根节点下有 `deviceId` 和 `data`，
     - `data` 下有 `temperature`、`humidity`。

3. 在绑定 `bindings` 中：
   - `source` 可填：`data.temperature` 或通过预览树点选生成；
   - `target` 可选：例如 `instance.instance.properties.temperature`，用于驱动实例属性。

---

## 四、注意事项

- 由于使用的是同一后端服务（端口 8000），前端从 `http://localhost:3000` 访问 `http://localhost:8000/mock/sensor` 已允许在 CORS 中配置，不会触发前面遇到的本机跨端口 403 限制。
- 若后端实际监听端口不是 8000，请将 HTTP 配置中的 API 地址改为实际端口，例如：
  - `http://localhost:8080/mock/sensor`
- Mock 接口可以按需要扩展字段结构，例如增加时间戳、数组等，再配合 IoT 绑定做更复杂的练习。

---

## 五、相关文件列表

| 文件 | 说明 |
|------|------|
| `app/routers/mock_http.py` | HTTP 模拟数据源路由，实现 `/mock/sensor` |
| `app/main.py` | 注册 `mock_http` 路由 |
| `web/src/services/httpApi.ts` | 前端 HTTP 连接配置 API（`createHTTP` / `getHTTPById`） |
| `web/src/components/DataPathHelper.tsx` | 数据预览中，协议为 HTTP 时通过 `fetch(httpConfig.base_url)` 获取数据 |

