from fastapi import APIRouter

router = APIRouter()


@router.get("/mock/sensor")
async def read_mock_sensor():
    """
    简单的 HTTP 模拟接口，用于 IoT HTTP 绑定 / 数据预览练习。

    访问地址（后端默认端口 8000 时）：
        GET http://localhost:8000/mock/sensor
    """
    return {
        "deviceId": "sensor-001",
        "data": {
            "temperature": 26.3,
            "humidity": 58.7,
        },
    }

