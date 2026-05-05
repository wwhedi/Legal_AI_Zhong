# New Feature: Aliyun KB + Qwen

独立 RAG 问答包，对外仅暴露 **`POST /new-rag/ask`**。

## 流程

1. **百炼知识库检索**：`AliyunKBService.retrieve` 拉取上下文与引用片段。  
2. **Qwen 生成**：`ReasoningService.generate` → `config/dashscope_config.create_chat_completion`（DashScope OpenAI 兼容模式）。

## 环境变量

- `DASHSCOPE_API_KEY`
- `BAILIAN_WORKSPACE_ID`
- `BAILIAN_INDEX_ID`
- `REASONING_MODEL_NAME`（默认 `qwen-max`）
- `NEW_QWEN_MODEL_NAME`（可选，覆盖新 RAG 使用的模型名）

## 请求示例

```bash
curl -X POST "http://127.0.0.1:8000/new-rag/ask" \
  -H "Content-Type: application/json" \
  -d "{\"question\":\"劳动合同试用期最长多久？\"}"
```
