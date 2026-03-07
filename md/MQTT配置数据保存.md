# MQTT 配置数据保存

本文档说明本系统中 **MQTT 连接配置从前端表单提交到写入 MongoDB 的完整流程**。

---

## 一、流程概览

```
[前端] 数据管理 → MQTT → 新建/保存
       ↓
handleFormSubmit(values) → 组装 data → mqttAPI.createMQTT(data)
       ↓
POST /mqtt/   (请求体: MQTT 配置 JSON)
       ↓
[后端] main.py 中 include_router(mqtt.router, prefix="/mqtt")
       ↓
app/routers/mqtt.py  create_mqtt_config(mqtt_data, db, user)
       ↓
MQTTCreate 校验 → mqtt_dict → db.mqtt_sources.insert_one(mqtt_dict)
       ↓
[MongoDB] 集合 mqtt_sources 中新增一条文档
```

---

## 二、前端：表单提交与请求

### 2.1 页面与入口

- **文件**：`web/src/pages/Data/MQTTData.tsx`
- **入口**：用户在「数据管理 → MQTT」中点击新建或保存后，触发表单提交，调用 **`handleFormSubmit`**（约 112–133 行）。

### 2.2 组装提交数据

```javascript
const data = {
  ...values,
  tags: Array.isArray(values.tags) ? values.tags : (values.tags ? [values.tags] : []),
  topics: Array.isArray(values.topics) ? values.topics : (values.topics ? [values.topics] : []),
};
```

- `values` 来自表单：name、hostname、port、websocket_path、username、password、topics 等。
- `tags`、`topics` 统一为数组后再提交。

### 2.3 发起请求

- **新建**：`await mqttAPI.createMQTT(data as MQTTCreate)`
- **编辑**：`await mqttAPI.updateMQTT(editingMQTT.id, data)`

### 2.4 API 封装

- **文件**：`web/src/services/mqttApi.ts`
- **创建**：`createMQTT(data)` 内部为 `api.post('/mqtt/', data)`，即 **POST `/mqtt/`**，请求体为 MQTT 配置对象。

---

## 三、路由注册

### 3.1 主应用挂载

- **文件**：`app/main.py`
- **代码**（约 96 行）：`app.include_router(mqtt.router, prefix="/mqtt", tags=["MQTT连接配置"])`

即：将 `mqtt.router` 下所有路由挂到前缀 **`/mqtt`**。

### 3.2 子路由定义

- **文件**：`app/routers/mqtt.py`
- **创建接口**：`@router.post("/", response_model=MQTTInDB)`，路径为 **`/`**（相对 prefix）。

**最终路由**：`/mqtt` + `/` → **POST `/mqtt/`**，由 `create_mqtt_config` 处理。

---

## 四、后端：接收、校验、写库

### 4.1 接口定义

**文件**：`app/routers/mqtt.py`（约 22–46 行）

```python
@router.post("/", response_model=MQTTInDB)
async def create_mqtt_config(
    mqtt_data: MQTTCreate,
    db=Depends(get_database),
    user=Depends(get_current_active_user)
):
```

- **mqtt_data**：请求体由 FastAPI 按 Pydantic 模型 `MQTTCreate` 校验，不通过则返回 422。
- **db**：通过 `Depends(get_database)` 注入，来自 `app/db/mongo_db.py`，即已连接好的 MongoDB 的 `db`。
- **user**：当前登录用户，未登录无法创建。

### 4.2 保存步骤

1. **转字典**：`mqtt_dict = mqtt_data.model_dump(exclude_unset=True)`，仅保留前端传入的字段。
2. **补时间戳**：`created_at`、`updated_at` 设为当前时间。
3. **补 client_id**：若未提供，则生成 `client_id = f"iot_client_{ObjectId()}"`。
4. **写入 MongoDB**：`result = await db.mqtt_sources.insert_one(mqtt_dict)`，集合名为 **`mqtt_sources`**。
5. **返回新文档**：`created_doc = await db.mqtt_sources.find_one({"_id": result.inserted_id})`，按 `MQTTInDB` 格式返回给前端。

---

## 五、数据模型（后端）

**文件**：`app/models/mqtt.py`

- **MQTTBase**：name、hostname、port、websocket_path、topics、description、tags、is_public 等。
- **MQTTCreate**：在 Base 上增加 client_id、keep_alive、username、password、use_tls、connection_timeout 等可选字段。

请求体字段需与模型一致，通过校验后都会进入 `mqtt_dict` 并写入 **MongoDB 的 `mqtt_sources` 集合**。插入后生成的 **`_id`** 即该条 MQTT 配置的 ID，在 IoT 绑定中作为 **sourceId** 使用。

---

## 六、关键文件速查

| 环节       | 文件路径 |
|------------|----------|
| 前端页面   | `web/src/pages/Data/MQTTData.tsx` |
| 前端 API   | `web/src/services/mqttApi.ts` |
| 路由注册   | `app/main.py` |
| 后端路由   | `app/routers/mqtt.py` |
| 数据模型   | `app/models/mqtt.py` |
| 数据库依赖 | `app/db/mongo_db.py` |

---

## 七、小结

- **保存位置**：MongoDB，集合 **`mqtt_sources`**。
- **创建入口**：前端 POST `/mqtt/`，后端 `create_mqtt_config`。
- **依赖**：`get_database()` 提供 `db`，`get_current_active_user` 保证已登录。
- **写入**：`db.mqtt_sources.insert_one(mqtt_dict)`，返回带 `_id` 的文档供前端使用。
=========================================================
用户在「数据管理」里进入 MQTT 页面，填好连接信息：名称、服务器地址、端口、WebSocket 路径、订阅的 topic、用户名密码等，点「新建」或「保存」。
前端把这些表单项整理成一个对象，把 tags、topics 之类统一成数组，然后调用接口：新建就发 POST /mqtt/，编辑就发带 id 的更新请求，请求体里就是这一份 MQTT 配置。

请求到了后端，先校验用户是否登录，再按 MQTTCreate 模型校验请求体（字段类型、必填项等），不通过会直接报错。
通过后，把请求体转成字典，只保留前端实际传了的字段，再补上创建时间、更新时间；如果没传 client_id，就自动生成一个（例如 iot_client_xxx）。
最后用 db.mqtt_sources.insert_one(...) 把这条配置写进 MongoDB 的 mqtt_sources 集合里。
插入成功后，数据库会生成一个 _id，后端根据这个 _id 把刚插入的那条文档查出来，按约定格式返回给前端。
前端拿到的这条配置（尤其是它的 _id）之后在配置 IoT 绑定时会当作 MQTT 数据源 ID（sourceId） 来用。

所以整件事就是：用户在页面上填 MQTT 连接信息并保存 → 前端发 POST /mqtt/ → 后端校验、补全、写入 MongoDB 的 mqtt_sources 集合 → 返回带 _id 的配置，供后续做 MQTT 数据源和绑定使用。
