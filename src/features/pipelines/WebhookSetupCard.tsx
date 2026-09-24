import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Copy, Eye, EyeOff, KeyRound, Link2, Terminal, Webhook } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  buildAirbyteWebhookUrl,
  buildBashWebhookExample,
  buildPowerShellWebhookExample,
  buildWebhookUrl,
} from "./webhookSetup";

interface WebhookSetupCardProps {
  pipelineId: string;
  secret: string | null;
}

async function copyText(value: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(`${label} copied`);
  } catch {
    toast.error(`Could not copy ${label.toLowerCase()}`);
  }
}

export function WebhookSetupCard({ pipelineId, secret }: WebhookSetupCardProps) {
  const [showSecret, setShowSecret] = useState(false);
  const url = useMemo(() => buildWebhookUrl(window.location.origin, pipelineId), [pipelineId]);
  const airbyteUrl = useMemo(() => secret ? buildAirbyteWebhookUrl(window.location.origin, pipelineId, secret) : null, [pipelineId, secret]);
  const bashExample = useMemo(() => buildBashWebhookExample(url, "<WEBHOOK_SECRET>"), [url]);
  const powerShellExample = useMemo(() => buildPowerShellWebhookExample(url, "<WEBHOOK_SECRET>"), [url]);
  const runnableBashExample = useMemo(() => buildBashWebhookExample(url, secret ?? "<WEBHOOK_SECRET>"), [secret, url]);
  const runnablePowerShellExample = useMemo(() => buildPowerShellWebhookExample(url, secret ?? "<WEBHOOK_SECRET>"), [secret, url]);

  useEffect(() => {
    setShowSecret(false);
  }, [secret]);

  return (
    <Card className="space-y-4 rounded-xs border-emerald-500/35 bg-emerald-500/5 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xs border border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
            <Webhook className="h-4 w-4" />
          </span>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium text-paper">Webhook endpoint active</h3>
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-emerald-300">
                <CheckCircle2 className="h-3 w-3" /> Ready
              </span>
            </div>
            <p className="mt-1 text-xs text-paper-muted">Send a successful external job event to start this pipeline.</p>
          </div>
        </div>
      </div>

      <div className="space-y-1.5">
        <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-paper-faint"><Link2 className="h-3 w-3" /> Endpoint URL</p>
        <div className="flex gap-2">
          <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-xs border border-ink-500 bg-ink-50 px-3 py-2.5 font-mono text-xs text-paper">{url}</code>
          <Button type="button" variant="outline" size="sm" onClick={() => void copyText(url, "Webhook URL")}><Copy className="h-3.5 w-3.5" /> Copy</Button>
        </div>
      </div>

      {airbyteUrl && <div className="space-y-1.5">
        <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-paper-faint"><Link2 className="h-3 w-3" /> Airbyte endpoint</p>
        <div className="flex gap-2">
          <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-xs border border-cyan-500/30 bg-cyan-500/5 px-3 py-2.5 font-mono text-xs text-cyan-100">{airbyteUrl}</code>
          <Button type="button" variant="outline" size="sm" onClick={() => void copyText(airbyteUrl, "Airbyte URL")}><Copy className="h-3.5 w-3.5" /> Copy</Button>
        </div>
        <p className="text-[11px] text-paper-muted">Paste this URL into Airbyte's webhook notification. The URL contains the deployment secret; rotate it by redeploying the pipeline.</p>
      </div>}

      <div className="space-y-1.5">
        <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-paper-faint"><KeyRound className="h-3 w-3" /> Authentication secret</p>
        {secret ? (
          <>
            <div className="flex gap-2">
              <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-xs border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 font-mono text-xs text-amber-100">
                {showSecret ? secret : "•".repeat(32)}
              </code>
              <Button type="button" variant="outline" size="sm" onClick={() => setShowSecret((current) => !current)}>
                {showSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                {showSecret ? "Hide" : "Show"}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => void copyText(secret, "Webhook secret")}><Copy className="h-3.5 w-3.5" /> Copy</Button>
            </div>
            <p className="text-[11px] text-amber-200/80">Save it now. CHouse encrypts it and will not show it again after this page is refreshed.</p>
          </>
        ) : (
          <div className="rounded-xs border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-xs text-amber-100">
            The secret is hidden after its one-time display. Use the value you saved, or deploy this pipeline as Webhook again to rotate it.
          </div>
        )}
      </div>

      <div className="rounded-xs border border-ink-500 bg-ink-50 p-3 text-xs text-paper-muted">
        <p className="font-medium text-paper">Request requirements</p>
        <ul className="mt-2 list-disc space-y-1 pl-4">
          <li><code>X-CHouse-Timestamp</code>: current Unix time in seconds; accepted within five minutes.</li>
          <li><code>X-CHouse-API-Key</code>: the secret above for quick testing.</li>
          <li>JSON body: <code>source</code>, <code>status</code>, and a unique <code>external_job_id</code> or <code>job_id</code>.</li>
          <li>Only <code>status: "succeeded"</code> starts a run; duplicate event IDs are ignored safely.</li>
          <li>For Airbyte, use the dedicated endpoint above. It accepts Airbyte's completion JSON and maps <code>data.success</code> to the pipeline status.</li>
        </ul>
      </div>

      <div className="space-y-2">
        <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-paper-faint"><Terminal className="h-3 w-3" /> Quick test</p>
        <Tabs defaultValue="powershell">
          <TabsList className="h-8 rounded-xs border border-ink-500 bg-ink-50 p-0.5">
            <TabsTrigger value="powershell" className="h-7 rounded-xs px-3 text-xs">PowerShell</TabsTrigger>
            <TabsTrigger value="bash" className="h-7 rounded-xs px-3 text-xs">Bash / macOS</TabsTrigger>
          </TabsList>
          <TabsContent value="powershell" className="relative mt-2">
            <Button type="button" variant="outline" size="sm" className="absolute right-2 top-2 z-10" onClick={() => void copyText(runnablePowerShellExample, secret ? "Runnable PowerShell example" : "PowerShell example")}><Copy className="h-3.5 w-3.5" /> {secret ? "Copy runnable" : "Copy"}</Button>
            <pre className="max-h-80 overflow-auto whitespace-pre rounded-xs border border-ink-500 bg-ink-50 p-3 pr-24 font-mono text-[11px] leading-5 text-paper-muted">{powerShellExample}</pre>
          </TabsContent>
          <TabsContent value="bash" className="relative mt-2">
            <Button type="button" variant="outline" size="sm" className="absolute right-2 top-2 z-10" onClick={() => void copyText(runnableBashExample, secret ? "Runnable Bash example" : "Bash example")}><Copy className="h-3.5 w-3.5" /> {secret ? "Copy runnable" : "Copy"}</Button>
            <pre className="max-h-80 overflow-auto whitespace-pre rounded-xs border border-ink-500 bg-ink-50 p-3 pr-24 font-mono text-[11px] leading-5 text-paper-muted">{bashExample}</pre>
          </TabsContent>
        </Tabs>
        <details className="rounded-xs border border-ink-500 bg-ink-50 px-3 py-2 text-xs text-paper-muted">
          <summary className="cursor-pointer font-medium text-paper">Production HMAC authentication</summary>
          <p className="mt-2 leading-5">Instead of sending the secret as an API key, set <code>X-CHouse-Signature</code> to the hexadecimal HMAC-SHA256 of <code>&lt;timestamp&gt;.&lt;raw JSON body&gt;</code> using the same secret.</p>
        </details>
      </div>
    </Card>
  );
}
