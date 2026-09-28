<#
  READ-ONLY: may production's code be rolled back below the Karigar metal
  custody release (b9a44e6 or later) right now?

    powershell -NoProfile -ExecutionPolicy Bypass -File "D:\Accounting\zynoraluxe-erp-rough-convert\scripts\custodyRollbackCheck.ps1"

  Code older than the custody release ignores Karigar custody. Rolling back
  to it is safe only while custody has left NO net trace:
    1. for every metal + purity, what was issued to Karigars has all come
       back to stock (same gross weight and same value), and
    2. no job holds an active custody allocation or release.
  Otherwise the old code would show metal that is with Karigars (or already
  inside finished pieces) as still in company stock. The database guards stop
  it from issuing that metal or touching those jobs, but the numbers it shows
  would be wrong -- so this prints UNSAFE with the exact entries to return or
  reverse first (with the CURRENT code), and never changes anything.

  Every query runs in a server-enforced READ ONLY transaction;
  the credential is read from the main checkout's .env and never printed.
#>
# -Scratch: rehearse against the local disposable scratch database instead of production.
param([switch]$Scratch)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$CredentialEnvFile  = "D:\Accounting\zynoraluxe-erp\.env"
$ExpectedProjectRef = "jjarojgsfezlwpwwjspe"
$PgBin              = "C:\Program Files\PostgreSQL\17\bin"

function Read-DirectUrl {
  foreach ($line in Get-Content -LiteralPath $CredentialEnvFile) {
    if ($line -match '^\s*DIRECT_URL\s*=\s*(.*?)\s*$') {
      $v = $Matches[1]
      if ($v.Length -ge 2 -and (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'")))) { $v = $v.Substring(1, $v.Length - 2) }
      return $v
    }
  }
  throw "DIRECT_URL missing in $CredentialEnvFile"
}

if ($Scratch) {
  $env:PGHOST = "localhost"; $env:PGPORT = "54329"; $env:PGDATABASE = "zynoraluxe_charge_scratch"; $env:PGUSER = "zynoraluxe_scratch_user"; $env:PGPASSWORD = ""; $env:PGSSLMODE = "disable"
  $env:PGCONNECT_TIMEOUT = "20"; $env:PGAPPNAME = "zynoraluxe-rollback-check"; $env:PGOPTIONS = "-c default_transaction_read_only=on"
  Write-Host "(rehearsal against the scratch database)"
} else {
$url = Read-DirectUrl
$pattern = '^postgres(?:ql)?://(?<user>[^:/@]+)(?::(?<pass>.*))?@(?<host>[^@:/?]+)(?::(?<port>\d+))?/(?<db>[^?]+)'
if (-not ($url -match $pattern)) { throw "DIRECT_URL is not a postgres:// URL." }
$user = [uri]::UnescapeDataString($Matches["user"])
if ($user -ne "postgres.$ExpectedProjectRef" -or $Matches["db"] -ne "postgres") { throw "DIRECT_URL is not the production project $ExpectedProjectRef -- refusing." }
$env:PGHOST = $Matches["host"]; $env:PGPORT = $(if ($Matches["port"]) { $Matches["port"] } else { "5432" }); $env:PGDATABASE = "postgres"
$env:PGUSER = $user; $env:PGPASSWORD = [uri]::UnescapeDataString($Matches["pass"]); $env:PGSSLMODE = "require"
$env:PGCONNECT_TIMEOUT = "20"; $env:PGAPPNAME = "zynoraluxe-rollback-check"; $env:PGOPTIONS = "-c default_transaction_read_only=on"
}

# Every query runs in its own READ ONLY transaction (psql -c sends the string as
# one transaction). PGOPTIONS alone is not enough: the Supabase pooler ignores it.
function Invoke-ReadOnly([string]$Query) {
  $Query = "SET TRANSACTION READ ONLY; " + $Query
  $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try { $out = & "$PgBin\psql.exe" -X -q -v ON_ERROR_STOP=1 -At -F "|" -c $Query 2>&1; $code = $LASTEXITCODE } finally { $ErrorActionPreference = $prev }
  if ($code -ne 0) { throw "Query failed: $($out -join ' ')" }
  return @($out | ForEach-Object { "$_" } | Where-Object { $_ })
}

$ro = @(Invoke-ReadOnly "select current_setting('transaction_read_only')")[-1]
if ($ro -ne "on") { throw "Session is not read-only -- refusing." }
$hasTable = @(Invoke-ReadOnly "select to_regclass('public.karigar_metal_custody_entries') is not null")[-1]
if ($hasTable -ne "t") { Write-Host "SAFE: the custody migration is not applied here; there is nothing to protect." -ForegroundColor Green; exit 0 }

$entries = [int](@(Invoke-ReadOnly "select count(*) from karigar_metal_custody_entries")[-1])
if ($entries -eq 0) { Write-Host "SAFE: no Karigar custody entry has ever been posted. A code rollback cannot misstate anything." -ForegroundColor Green; exit 0 }

# 1. Warehouse trace per metal + purity: issues to Karigars minus returns (weight and value).
$trace = @(Invoke-ReadOnly ("select p.to_jsonb->>'displayName', sum(case m.to_jsonb->>'type' when 'KARIGAR_ISSUE_OUT' then 1 when 'KARIGAR_RETURN_IN' then -1 else 0 end * (m.to_jsonb->>'grossWeight')::numeric), " +
  "sum(case m.to_jsonb->>'type' when 'KARIGAR_ISSUE_OUT' then 1 when 'KARIGAR_RETURN_IN' then -1 else 0 end * (m.to_jsonb->>'costValue')::numeric) " +
  "from (select to_jsonb(x) from metal_stock_movements x) m join (select id, to_jsonb(y) from metal_purities y) p on p.id = m.to_jsonb->>'purityId' " +
  "where m.to_jsonb->>'type' in ('KARIGAR_ISSUE_OUT', 'KARIGAR_RETURN_IN') group by 1 having sum(case m.to_jsonb->>'type' when 'KARIGAR_ISSUE_OUT' then 1 when 'KARIGAR_RETURN_IN' then -1 else 0 end * (m.to_jsonb->>'grossWeight')::numeric) <> 0 " +
  "or sum(case m.to_jsonb->>'type' when 'KARIGAR_ISSUE_OUT' then 1 when 'KARIGAR_RETURN_IN' then -1 else 0 end * (m.to_jsonb->>'costValue')::numeric) <> 0"))

# 2. Active job-linked custody entries (allocation / release not reversed).
$active = @(Invoke-ReadOnly ("select e.to_jsonb->>'entryCode', e.to_jsonb->>'kind', j.to_jsonb->>'jobCode' from (select id, to_jsonb(x) from karigar_metal_custody_entries x) e " +
  "join (select id, to_jsonb(y) from jewellery_jobs y) j on j.id = e.to_jsonb->>'jobId' " +
  "where e.to_jsonb->>'reversalOfEntryId' is null and not exists (select 1 from karigar_metal_custody_entries r where to_jsonb(r)->>'reversalOfEntryId' = e.id) order by 1"))

if ($trace.Count -eq 0 -and $active.Count -eq 0) {
  Write-Host "SAFE: $entries custody entr$(if ($entries -eq 1) { 'y exists' } else { 'ies exist' }), but every issue has come back to stock and no job holds custody metal." -ForegroundColor Green
  exit 0
}
Write-Host "UNSAFE: do NOT roll back the code below the custody release." -ForegroundColor Red
if ($trace.Count -gt 0) {
  Write-Host "  Metal issued to Karigars and not returned to stock (older code would count it as still in stock):"
  foreach ($t in $trace) { $f = $t -split '\|'; Write-Host ("    {0}: {1} g gross, Rs {2}" -f $f[0], $f[1], $f[2]) }
}
if ($active.Count -gt 0) {
  Write-Host "  Jobs holding active custody entries (reverse these newest-first with the CURRENT code, or keep the current code):"
  foreach ($a in $active) { $f = $a -split '\|'; Write-Host ("    {0}  {1}  {2}" -f $f[0], $f[1], $f[2]) }
}
Write-Host "  Fix forward instead of rolling back. Nothing was changed by this check."
exit 2
