import json
import os
import sys

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

def load_env_file(env_path: str) -> None:
    if not os.path.exists(env_path):
        return
    with open(env_path, "r", encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and (key not in os.environ or not (os.environ.get(key) or "").strip()):
                os.environ[key] = value


def create_client():
    from alibabacloud_bailian20231229.client import Client as BailianClient
    from alibabacloud_credentials.client import Client as CredentialClient
    from alibabacloud_tea_openapi import models as open_api_models

    credential = CredentialClient()
    config = open_api_models.Config(credential=credential)
    config.endpoint = "bailian.cn-beijing.aliyuncs.com"
    return BailianClient(config)


def main() -> None:
    script_dir = os.path.dirname(os.path.abspath(__file__))
    load_env_file(os.path.join(script_dir, ".env"))

    workspace_id = (os.getenv("BAILIAN_WORKSPACE_ID", "") or "").strip()
    # 优先使用明确的 IndexId；未配置时兼容沿用你当前 .env 里的 BAILIAN_CATEGORY_ID
    index_id = (os.getenv("BAILIAN_INDEX_ID", "") or "").strip() or (os.getenv("BAILIAN_CATEGORY_ID", "") or "").strip()
    index_name = (os.getenv("BAILIAN_KNOWLEDGE_BASE_NAME", "") or "").strip()

    if not workspace_id:
        raise RuntimeError("缺少 BAILIAN_WORKSPACE_ID")
    if not index_id:
        raise RuntimeError("缺少 BAILIAN_INDEX_ID（或 BAILIAN_CATEGORY_ID）")
    if not index_name:
        index_name = input("请输入要更新的知识库名称（name）：").strip()
    if not index_name:
        raise RuntimeError("缺少知识库名称（BAILIAN_KNOWLEDGE_BASE_NAME 或手动输入）")

    from alibabacloud_bailian20231229 import models as bailian_models
    from alibabacloud_tea_util import models as util_models

    client = create_client()
    req = bailian_models.UpdateIndexRequest(
        id=index_id,
        name=index_name,
    )
    runtime = util_models.RuntimeOptions()
    resp = client.update_index_with_options(workspace_id, req, {}, runtime)
    print(json.dumps(resp.to_map(), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
