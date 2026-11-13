import "./noDevtools";
import { BuiltinActionType, Renderer, type ActionEvent } from "@openuidev/react-lang";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Component, useCallback, useState, type ReactNode } from "react";
import { send } from "@/agents/orchestrator";
import { inTauri } from "@/agents/runner";
import { actionMessage } from "@/lib/uiBlocks";
import { cubeLibrary } from "./library";

/** A view that cannot be drawn is shown as what the cube wrote, never as an error in the middle of the chat. */
class Guard extends Component<{ fallback: ReactNode; children: ReactNode }, { broken: boolean }> {
  state = { broken: false };
  static getDerivedStateFromError() {
    return { broken: true };
  }
  render() {
    return this.state.broken ? this.props.fallback : this.props.children;
  }
}

const Written = ({ code }: { code: string }) => (
  <pre className="selectable overflow-x-auto rounded-[14px] border bg-muted/50 p-3 text-xs" data-notranslate>
    <code>{code}</code>
  </pre>
);

/**
 * One view a cube put in its reply, drawn with Cube's own components. A button in it never acts
 * by itself: what it would say to the cubes is shown first, and goes only when the person sends it.
 */
export default function IntelligentBlock({ code, streaming, convId, parentId }: { code: string; streaming: boolean; convId: string; parentId?: string }) {
  const [failed, setFailed] = useState(false);
  /** What a pressed button would send, waiting for the person's go-ahead. */
  const [pending, setPending] = useState<string>();

  const onAction = useCallback((event: ActionEvent) => {
    if (event.type === BuiltinActionType.OpenUrl) {
      const url = String(event.params?.url ?? "");
      // Only web pages, and only through the system browser: the same rule as a link in a message.
      if (inTauri && /^https?:\/\//.test(url)) void openUrl(url);
      return;
    }
    if (event.type === BuiltinActionType.ContinueConversation) {
      const text = actionMessage(event.humanFriendlyMessage, [event.params?.context, event.formState]);
      if (text) setPending(text);
    }
  }, []);

  if (failed) return <Written code={code} />;
  return (
    <div className="flex w-full max-w-[640px] flex-col gap-2">
      {/* What the cube wrote is in the language it wrote it in. */}
      <div data-notranslate>
      <Guard fallback={<Written code={code} />}>
        <Renderer
          response={code}
          library={cubeLibrary}
          isStreaming={streaming}
          onAction={onAction}
          publishObservability={false}
          // Once the cube has finished writing, a program with nothing to draw is shown as it was written.
          onParseResult={(result) => { if (!streaming && result && !result.root) setFailed(true); }}
        />
      </Guard>
      </div>
      {pending !== undefined && (
        <div className="flex flex-col gap-2 rounded-[14px] border border-primary/40 bg-primary/5 p-2.5">
          <span className="text-xs font-semibold text-muted-foreground">This will be sent to the cubes</span>
          <p className="selectable whitespace-pre-wrap text-[13px] [overflow-wrap:anywhere]" data-notranslate>{pending}</p>
          <div className="flex gap-1.5">
            <button type="button" className="h-7 rounded-full bg-primary px-3 text-[13px] font-semibold text-primary-foreground" onClick={() => { send(convId, pending, parentId); setPending(undefined); }}>Send</button>
            <button type="button" className="h-7 rounded-full bg-secondary px-3 text-[13px] font-semibold" onClick={() => setPending(undefined)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
