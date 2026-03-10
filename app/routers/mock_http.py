from fastapi import APIRouter

router = APIRouter()


@router.get("/mock/sensor")
async def read_mock_sensor():
    """
    简单的 HTTP 模拟接口，用于 IoT HTTP 绑定 / 数据预览练习。

    访问地址（后端默认端口 8000 时）：
        GET http://localhost:8000/mock/sensor
    """
    # up by xiu: 内置 HTTP 模拟数据源，统一给 MQTT / WebSocket 测试对齐的数据结构
    return {
        "deviceId": "sensor-001",
        "data": {
            "location": [10, 30, 10],
            "humidity": 58.7,
        },
    }

