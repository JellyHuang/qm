import type { NoticeKind } from "./decision.ts";
import type { JenkinsBuildRecord } from "./store.ts";

export interface JenkinsNoticeSink {
  send(notice: { id: string; channelId: string; text: string }): Promise<void>;
}

export interface RecordingSink extends JenkinsNoticeSink {
  sent: Array<{ id: string; channelId: string; text: string }>;
}

export function createRecordingSink(): RecordingSink {
  const sent: RecordingSink["sent"] = [];
  return {
    sent,
    async send(notice) {
      sent.push(notice);
    },
  };
}

const mention = (owner: string | undefined): string => (owner ? ` @${owner}` : "");

export function noticeText(
  kind: NoticeKind,
  record: Pick<
    JenkinsBuildRecord,
    "job" | "number" | "url" | "result" | "reason" | "rerunNumber" | "rerunUrl" | "rerunResult"
  >,
  owner: string | undefined,
  hourlyCap: number,
): string {
  const original = `${record.job} #${record.number}(${record.result})${record.url ? ` ${record.url}` : ""}`;
  if (kind === "rerun_failed")
    return `Jenkins 自动重跑后仍然失败:${original}。重跑 #${record.rerunNumber}(${record.rerunResult})${record.rerunUrl ? ` ${record.rerunUrl}` : ""}。不会再次重跑,请处理。${mention(owner)}`;
  if (kind === "circuit_open")
    return `Jenkins 自动重跑已暂停:${record.job} 一小时内已自动重跑 ${hourlyCap} 次,达到上限,之后的失败不再自动重跑。${mention(owner)}`;
  return `Jenkins 构建需要人工处理:${original}。没有自动重跑,原因:${record.reason}。${mention(owner)}`;
}
