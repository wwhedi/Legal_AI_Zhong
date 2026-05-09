from __future__ import annotations

from typing import Any, Optional, TypedDict


class KBUploadRecordDict(TypedDict, total=False):
    id: str
    law_id: str
    law_name: str
    version_hash: str
    export_file_path: str
    export_file_name: str
    bailian_file_id: str
    bailian_job_id: str
    upload_status: str
    index_status: str
    uploaded_at: str
    last_error: str
    created_at: str
    updated_at: str


def row_to_dict(row: Any) -> Optional[KBUploadRecordDict]:
    if row is None:
        return None
    keys = (
        "id",
        "law_id",
        "law_name",
        "version_hash",
        "export_file_path",
        "export_file_name",
        "bailian_file_id",
        "bailian_job_id",
        "upload_status",
        "index_status",
        "uploaded_at",
        "last_error",
        "created_at",
        "updated_at",
    )
    return {k: row[k] for k in keys if k in row.keys()}
