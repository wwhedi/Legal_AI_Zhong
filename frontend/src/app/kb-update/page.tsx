import type { Metadata } from "next";
import KbUpdateHomeClient from "./KbUpdateHomeClient";

export const metadata: Metadata = {
  title: "【更新知识库】",
};

export default function KnowledgeBaseUpdatePage() {
  return <KbUpdateHomeClient />;
}
