export function buildWebhookUrl(origin: string, pipelineId: string): string {
  const base = origin.replace(/\/$/, "");
  return `${base}/api/pipelines/${encodeURIComponent(pipelineId)}/webhook`;
}

export function buildAirbyteWebhookUrl(origin: string, pipelineId: string, secret: string): string {
  const base = origin.replace(/\/$/, "");
  return `${base}/api/pipelines/${encodeURIComponent(pipelineId)}/webhook/airbyte?token=${encodeURIComponent(secret)}`;
}

export function buildBashWebhookExample(url: string, secret: string): string {
  return `timestamp=$(date +%s)
event_id="manual-test-$timestamp"

curl --request POST \\
  --url '${url}' \\
  --header 'Content-Type: application/json' \\
  --header "X-CHouse-Timestamp: $timestamp" \\
  --header 'X-CHouse-API-Key: ${secret}' \\
  --data "{\\\"source\\\":\\\"manual-test\\\",\\\"status\\\":\\\"succeeded\\\",\\\"external_job_id\\\":\\\"$event_id\\\"}"`;
}

export function buildPowerShellWebhookExample(url: string, secret: string): string {
  return `$timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$body = @{
  source = "manual-test"
  status = "succeeded"
  external_job_id = "manual-test-$timestamp"
} | ConvertTo-Json -Compress

Invoke-RestMethod \`
  -Method Post \`
  -Uri "${url}" \`
  -Headers @{
    "X-CHouse-Timestamp" = "$timestamp"
    "X-CHouse-API-Key" = "${secret}"
  } \`
  -ContentType "application/json" \`
  -Body $body`;
}
