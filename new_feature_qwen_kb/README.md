# New Feature: Aliyun KB + Qwen

该目录存放独立新增功能：

- 每次提问都会先调用阿里云知识库检索（`AliyunKBService.retrieve`）。
- 再使用 Qwen 模型生成答案（`ReasoningService.generate`）。
- 对外 API：`POST /new-rag/ask`。

## 环境变量

- `DASHSCOPE_API_KEY`
- `BAILIAN_WORKSPACE_ID`
- `BAILIAN_INDEX_ID`
- `REASONING_MODEL_NAME`（默认 `qwen-max`）
- `NEW_QWEN_MODEL_NAME`（可选，用于覆盖新功能模型，例如 `qwen-plus`）

## 请求示例

```bash
curl -X POST "http://127.0.0.1:8000/new-rag/ask" \
  -H "Content-Type: application/json" \
  -d "{\"question\":\"劳动合同试用期最长多久？\"}"
```
