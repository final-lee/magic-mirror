import { useQuery } from "@tanstack/react-query";
import { errorMessage } from "../../api/errors";
import { formatDateTime } from "../../iam/format";
import { sqsApi } from "../api";
import { sqsKeys } from "../queries";
import type { SqsQueue } from "../types";
import { SqsChangeDialog } from "./SqsChangeDialog";
import * as t from "./text";
import { useSqsChange } from "./useSqsChange";

interface Props { profile: string; region: string; queue: SqsQueue }

export function DlqRedrive(props: Props) {
  return <Panel key={`${props.profile}:${props.region}:${props.queue.url}`} {...props} />;
}

function Panel({ profile, region, queue }: Props) {
  const tasks = useQuery({
    queryKey: sqsKeys.moveTasks(profile, region, queue.url),
    queryFn: () => sqsApi.moveTasks(profile, region, queue.url),
    refetchInterval: (q) => q.state.data?.some((task) => task.status === "RUNNING" || task.status === "CANCELLING") ? 5000 : false,
  });
  const flow = useSqsChange(profile, region, queue.url);

  return (
    <section className="sqs-change-tasks">
      <h3>{t.TASKS}</h3>
      {tasks.isLoading && <p>{t.LOADING_TASKS}</p>}
      {tasks.isError && <p role="alert">{errorMessage(tasks.error)}</p>}
      {tasks.data?.length === 0 && <p>{t.NO_TASKS}</p>}
      {tasks.data?.map((task, i) => (
        <div className="sqs-change-task" key={task.taskHandle ?? `${task.startedAt}-${i}`}>
          <strong>{t.TASK_STATUS[task.status] ?? task.status}</strong> <span>{formatDateTime(new Date(task.startedAt).toISOString())}</span>
          <p>{t.MOVED(task.moved, task.toMove)}</p>
          {task.toMove !== null && task.toMove > 0 && <progress value={Math.min(task.moved, task.toMove)} max={task.toMove} />}
          {task.destinationArn && <p>{t.TARGET(task.destinationArn.slice(task.destinationArn.lastIndexOf(":") + 1))}</p>}
          {task.failureReason && <p role="alert">{task.failureReason}</p>}
          {task.status === "RUNNING" && task.taskHandle && (
            <button className="btn tone-caution" onClick={() => flow.start({ kind: "cancelMoveTask", taskHandle: task.taskHandle! })}>
              {t.CANCEL_MOVE}
            </button>
          )}
        </div>
      ))}
      {flow.notice && <p role="status">{flow.notice}</p>}
      {flow.pending && <SqsChangeDialog pending={flow.pending} onApply={flow.apply} onRetry={flow.retryPreview} onCancel={flow.cancel} />}
    </section>
  );
}
