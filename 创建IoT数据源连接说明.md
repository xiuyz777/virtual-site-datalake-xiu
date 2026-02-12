# 创建 IoT 数据源连接 - 详情说明

本文档说明如何创建 MQTT、HTTP、WebSocket 三类 IoT 数据源连接：接口路径、请求体、存储位置与使用方式。

---

## 一、总览

| 协议       | 创建接口路径     | 请求体模型   | MongoDB 集合        | 路由文件      |
|------------|------------------|--------------|---------------------|---------------|
| MQTT       | POST /mqtt/      | MQTTCreate   | mqtt_sources        | app/routers/mqtt.py |
| HTTP       | POST /http/      | HTTPCreate   | http_sources        | app/routers/http.py |
| WebSocket  | POST /websockets/| WebSocketCreate | websocket_sources | app/routers/websocket.py |

- 所有创建接口均需登录：`get_current_active_user`。
- 创建成功后返回的文档中包含 `_id`，**IoT 绑定的 sourceId 即使用该 _id（转为字符串）**。

---

## 二、MQTT 数据源连接

### 1. 接口

- **路径**：`POST /mqtt/`
- **文件**：`app/routers/mqtt.py`（约 22–46 行）

### 2. 创建逻辑（逐行）

```python
mqtt_dict = mqtt_data.model_dump(exclude_unset=True)
mqtt_dict["created_at"] = datetime.utcnow()
mqtt_dict["updated_at"] = datetime.utcnow()

# 未传 client_id 时自动生成
if not mqtt_dict.get("client_id"):
    mqtt_dict["client_id"] = f"iot_client_{ObjectId()}"

result = await db.mqtt_sources.insert_one(mqtt_dict)
created_doc = await db.mqtt_sources.find_one({"_id": result.inserted_id})
return created_doc
```

- 写入 **MongoDB 集合 `mqtt_sources`**，返回带 `_id` 的完整文档。

### 3. 请求体：MQTTCreate（app/models/mqtt.py）

**必填**（来自 MQTTBase + MQTTCreate）：

| 字段        | 类型   | 说明 |
|-------------|--------|------|
| name        | str    | 连接名称 |
| hostname    | str    | MQTT Broker 主机名 |
| port        | int    | 端口，默认 1883 |
| websocket_path | str | WebSocket 路径，默认 "/mqtt" |

**可选常用**：

| 字段        | 类型   | 默认 | 说明 |
|-------------|--------|------|------|
| description | str    | None | 描述 |
| tags        | list   | []   | 标签 |
| is_public   | bool   | True | 是否公开 |
| client_id   | str    | 自动生成 | 客户端 ID |
| keep_alive  | int    | 60   | 保活间隔（秒） |
| clean_session | bool | True | 清除会话 |
| auth_type   | str    | "none" | none / username_password / certificate |
| username    | str    | None | 用户名 |
| password    | str    | None | 密码 |
| use_tls     | bool   | False | 是否 TLS |
| tls_insecure | bool  | False | 是否跳过证书校验 |
| default_qos | int    | 0    | 默认 QoS（0/1/2） |
| connection_timeout | int | 10 | 连接超时（秒） |
| max_retries | int    | 3    | 最大重试次数 |
| retry_delay | int    | 5    | 重试间隔（秒） |
| topics      | list   | []   | 订阅主题列表 |

### 4. 返回

- 类型：`MQTTInDB`（含 `_id`、created_at、updated_at 及上述字段）。
- **sourceId**：创建后取返回的 `_id`，转为字符串，用于 IoT 绑定的 `sourceId`。

---

## 三、HTTP 数据源连接

### 1. 接口

- **路径**：`POST /http/`
- **文件**：`app/routers/http.py`（约 22–44 行）

### 2. 创建逻辑

```python
http_dict = http_data.model_dump(exclude_unset=True)
http_dict["created_at"] = datetime.utcnow()
http_dict["updated_at"] = datetime.utcnow()

result = await db.http_sources.insert_one(http_dict)
created_doc = await db.http_sources.find_one({"_id": result.inserted_id})
return created_doc
```

- 写入 **MongoDB 集合 `http_sources`**。

### 3. 请求体：HTTPCreate（app/models/http.py）

**必填**：

| 字段     | 类型 | 说明 |
|----------|------|------|
| name     | str  | 连接名称 |
| base_url | str  | 请求基础 URL |

**可选常用**：

| 字段          | 类型 | 默认   | 说明 |
|---------------|------|--------|------|
| description   | str  | None   | 描述 |
| tags          | list | []     | 标签 |
| method        | str  | "GET"  | GET/POST/PUT/DELETE/PATCH |
| headers       | dict | None   | 请求头 |
| default_params| dict | None   | 默认查询参数 |
| auth_type     | str  | "none" | none/basic/bearer/api_key/oauth2 |
| auth_token    | str  | None   | Bearer Token |
| api_key       | str  | None   | API Key |
| timeout       | int  | 30     | 超时（秒） |
| verify_ssl    | bool | True   | 是否校验 SSL |
| poll_interval | int  | None   | 轮询间隔（秒），None 表示单次请求 |
| poll_enabled  | bool | False  | 是否启用轮询 |
| response_format | str | "json" | json/xml/text/binary |
| json_path     | str  | None   | 提取数据的 JSONPath |

### 4. 返回

- 文档含 `_id`，其字符串形式即 IoT 绑定的 **sourceId**。

---

## 四、WebSocket 数据源连接

### 1. 接口

- **路径**：`POST /websockets/`
- **文件**：`app/routers/websocket.py`（约 16–37 行）

### 2. 创建逻辑

```python
websocket_dict = websocket_data.model_dump(exclude_unset=True)
websocket_dict["created_at"] = datetime.utcnow()
websocket_dict["updated_at"] = datetime.utcnow()

result = await db.websocket_sources.insert_one(websocket_dict)
created_doc = await db.websocket_sources.find_one({"_id": result.inserted_id})
return created_doc
```

- 写入 **MongoDB 集合 `websocket_sources`**。

### 3. 请求体：WebSocketCreate（app/models/websocket.py）

**必填**：

| 字段 | 类型 | 说明 |
|------|------|------|
| name | str  | 连接名称 |
| url  | str  | WebSocket 连接 URL |

**可选常用**：

| 字段               | 类型 | 默认 | 说明 |
|--------------------|------|------|------|
| description        | str  | None | 描述 |
| tags               | list | []   | 标签 |
| headers            | dict | None | 连接时请求头 |
| protocols          | list | None | 子协议列表 |
| auth_type          | str  | "none" | none/basic/token/custom |
| auth_token         | str  | None | Token 认证 |
| connection_timeout | int  | 10   | 连接超时（秒） |
| ping_interval      | int  | 30   | Ping 间隔（秒） |
| ping_timeout       | int  | 10   | Ping 超时（秒） |
| max_retries        | int  | 3    | 最大重试次数 |
| retry_delay        | int  | 5    | 重试间隔（秒） |

### 4. 返回

- 文档含 `_id`，其字符串形式即 **sourceId**。

---

## 五、与 IoT 绑定的衔接

1. **创建数据源**：调用上述任一 `POST` 接口，得到带 `_id` 的文档。
2. **记下 sourceId**：`sourceId = str(返回的 _id)`。
3. **创建绑定时使用**：在 `POST /scenes/{scene_id}/instances/{instance_id}/iot-bindings` 的请求体中设置：
   - `protocol`：`"mqtt"` / `"http"` / `"websocket"`
   - `sourceId`：上一步的字符串 `_id`

4. **前端拉取连接配置**：
   - 按协议分别请求：
     - `GET /mqtt/{mqtt_id}` 
     - `GET /http/{http_id}` 
     - `GET /websockets/{websocket_id}` 
   - 或使用统一入口（若项目在 `/iot` 下封装了按 id 查任意协议），传入的 id 即为上述 sourceId。

---

## 六、统一查询说明（iot_connections）

**文件**：`app/routers/iot_connections.py`

- `find_connection_by_id(db, connection_id)` 会在 **mqtt_connections、http_connections、websocket_connections** 三个集合中按 `_id` 查找。
- 当前**创建**接口写入的是 **mqtt_sources、http_sources、websocket_sources**。
- 若希望“按 connection_id 统一查连接”的逻辑能用到刚创建的数据源，需要：
  - 要么让统一查询改为从 `mqtt_sources` / `http_sources` / `websocket_sources` 读；  
  - 要么在创建时同时写入 `*_connections` 集合，或做集合别名/同步。

创建接口本身以 **mqtt_sources / http_sources / websocket_sources** 为准；**IoT 绑定的 sourceId 使用创建接口返回的 _id 字符串**即可。

---

## 七、小结

- **MQTT**：`POST /mqtt/`，Body 为 MQTTCreate，写入 `mqtt_sources`，返回含 `_id`。
- **HTTP**：`POST /http/`，Body 为 HTTPCreate，写入 `http_sources`，返回含 `_id`。
- **WebSocket**：`POST /websockets/`，Body 为 WebSocketCreate，写入 `websocket_sources`，返回含 `_id`。
- **IoT 绑定**：创建绑定时的 `sourceId` 填上述任一路径返回的 `_id` 的字符串形式。
- 所有连接配置均存于 **MongoDB**，与 Neo4j 中的实例、绑定（Instance.iot_binds）分离：连接在 Mongo，绑定在 Neo4j。
