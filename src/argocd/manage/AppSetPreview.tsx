import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { parse } from "yaml";
import { errorMessage } from "../../api/errors";
import { CodeEditor } from "../../components/CodeEditor";
import { TextDiffView } from "../../explorer/TextDiffView";
import type { ArgoChange } from "../change/types";
import { manageApi } from "./api";
import { classifyGenerated, countChanges, type AppChange } from "./appSetDiff";
import { useAppSetApps } from "./queries";
import { deepEqual } from "./specForm";
import {
  APPSET_EDIT_HINT, APPSET_EDIT_LABEL, APPSET_GENERATE, APPSET_GENERATING, APPSET_KIND_TEXT, APPSET_PREVIEW_FIRST, APPSET_RESET, APPSET_SAVE, APPSET_SHOW_SAME, APPSET_STALE,
  APPSET_UNCHANGED, appSetCounts, MANAGE_LOADING, MANAGE_NAME_LOCKED,
} from "./text";
import type { AppSetDetail } from "./types";
import { gateYaml } from "./yamlGate";

interface Props {
  url: string;
  set: AppSetDetail;
  /** 저장 미리 보기(appSetUpsert)를 연다 */
  onChange: (change: ArgoChange) => void;
}

/**
 * 고친 ApplicationSet YAML이 만들 앱을 서버에 계산시켜 지금 앱과 견준다(추가·삭제·변경). 계산만으로는 아무것도 저장하지 않고,
 * 저장은 변경 미리 보기(ChangeSheet)를 거친다.
 */
export function AppSetPreview({ url, set, onChange }: Props) {
  const [text, setText] = useState(set.yaml);
  const [round, setRound] = useState(0);
  const [generatedFrom, setGeneratedFrom] = useState<string | null>(null);
  const [showSame, setShowSame] = useState(false);
  const current = useAppSetApps(url, set.namespace, set.name, true);
  const generate = useMutation({ mutationFn: (yaml: string) => manageApi.generate(url, yaml), onSuccess: (_apps, yaml) => setGeneratedFrom(yaml) });

  const gate = useMemo(() => gateYaml(text), [text]);
  const renamed = gate.ok && ((gate.value?.metadata as { name?: string } | undefined)?.name !== set.name);
  const unchanged = useMemo(() => {
    if (!gate.ok) return false;
    try {
      return deepEqual(gate.value, parse(set.yaml));
    } catch {
      return false;
    }
  }, [gate, set.yaml]);
  const changes = useMemo(() => (generate.data && current.data ? classifyGenerated(generate.data, current.data) : null), [generate.data, current.data]);
  const counts = changes ? countChanges(changes) : null;
  const stale = generatedFrom !== null && generatedFrom !== text;
  const reason = gate.reason ?? (renamed ? MANAGE_NAME_LOCKED : null);
  const ready = gate.ok && !renamed;

  return (
    <div className="mg-form">
      <section className="k8s-sect">
        <p className="dim">{APPSET_EDIT_HINT}</p>
        <CodeEditor key={round} value={text} onChange={setText} label={APPSET_EDIT_LABEL} minHeight="320px" />
      </section>
      {reason && (
        <p className="err" role="alert">
          {reason}
        </p>
      )}
      <div className="mg-foot">
        <button
          className="btn small tone-ghost"
          onClick={() => {
            setText(set.yaml);
            setRound((n) => n + 1);
          }}
        >
          {APPSET_RESET}
        </button>
        <button className="btn small tone-secondary" disabled={!ready || generate.isPending} onClick={() => generate.mutate(text)}>
          {generate.isPending ? APPSET_GENERATING : APPSET_GENERATE}
        </button>
        <button
          className="btn small tone-primary"
          disabled={!ready || unchanged}
          title={unchanged ? APPSET_UNCHANGED : undefined}
          onClick={() => onChange({ kind: "appSetUpsert", yaml: text })}
        >
          {APPSET_SAVE}
        </button>
      </div>
      {generate.isError && (
        <p className="err" role="alert">
          {errorMessage(generate.error)}
        </p>
      )}
      {generatedFrom === null && !generate.isPending && <p className="dim">{APPSET_PREVIEW_FIRST}</p>}
      {stale && <p className="dim">{APPSET_STALE}</p>}
      {generate.data && current.isPending && <p className="dim">{MANAGE_LOADING}</p>}
      {current.isError && (
        <p className="err" role="alert">
          {errorMessage(current.error)}
        </p>
      )}
      {changes && counts && (
        <section className="k8s-sect" aria-label={APPSET_GENERATE}>
          <h4>{appSetCounts(counts.added, counts.removed, counts.changed, counts.same)}</h4>
          <label className="k8s-check">
            <input type="checkbox" checked={showSame} onChange={(e) => setShowSame(e.target.checked)} />
            {APPSET_SHOW_SAME}
          </label>
          <div className="mg-changes">
            {changes
              .filter((c) => showSame || c.kind !== "same")
              .map((c) => (
                <ChangeRow key={c.key} change={c} />
              ))}
          </div>
        </section>
      )}
    </div>
  );
}

function ChangeRow({ change }: { change: AppChange }) {
  const [open, setOpen] = useState(false);
  const diff = useQuery({ queryKey: ["argocd", "manage", "yaml-diff", change.key, change.before, change.after], queryFn: () => manageApi.yamlDiff(change.before ?? "", change.after ?? ""), enabled: open, retry: false });
  const info = change.generated;
  return (
    <div className={`mg-change mg-${change.kind}`}>
      <button className="mg-change-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="argo-band-tw">{open ? "▾" : "▸"}</span>
        <span className={`argo-badge ${change.kind === "removed" ? "argo-bad" : change.kind === "added" ? "argo-ok" : change.kind === "changed" ? "argo-warn" : ""}`}>{APPSET_KIND_TEXT[change.kind]}</span>
        <b className="mono">{change.name}</b>
        {info && <span className="dim mono">{[info.project, info.destination].filter(Boolean).join(" · ")}</span>}
      </button>
      {open && (diff.data ? <TextDiffView rows={diff.data.rows} /> : diff.isError ? <p className="err">{errorMessage(diff.error)}</p> : <p className="dim">{MANAGE_LOADING}</p>)}
    </div>
  );
}
