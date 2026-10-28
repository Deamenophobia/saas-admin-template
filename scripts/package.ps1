$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskVersion = (Get-Content -LiteralPath (Join-Path $taskRoot 'package.json') -Raw | ConvertFrom-Json).version
if ($taskVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid package version' }
$taskRelease = Join-Path $taskRoot 'release'
New-Item -ItemType Directory -Path $taskRelease -Force | Out-Null
$taskArchive = Join-Path $taskRelease "saas-admin-template-$taskVersion.zip"
if (Test-Path -LiteralPath $taskArchive) { throw "Archive already exists: $taskArchive. Choose a new version or rename the previous archive." }
# Explicit allowlist: no .env secrets, Git metadata, node_modules, logs or local DB.
$taskInclude = @('.env.example','.gitattributes','.gitignore','AGENTS.md','LICENSE','README.md',
  'docker-compose.yml','openapi.json','package.json','package-lock.json','tsconfig.json','tsconfig.examples.json',
  'CHANGELOG.md','SECURITY.md','CONTRIBUTING.md',
  'docs','licenses','prisma','scripts','src','tests','examples')
$taskPaths = $taskInclude | ForEach-Object { Join-Path $taskRoot $_ }
Compress-Archive -LiteralPath $taskPaths -DestinationPath $taskArchive -CompressionLevel Optimal
# Check the actual ZIP entries, including platform handling of dotfiles.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$taskZip = [IO.Compression.ZipFile]::OpenRead($taskArchive)
try {
  $taskEntries = @($taskZip.Entries | ForEach-Object { $_.FullName.Replace('\','/') })
  foreach ($taskRequired in @('.env.example','package-lock.json','README.md','prisma/schema.prisma','examples/api-client.mjs',
    'prisma/migrations/003_product_extensions/migration.sql','docs/EXTENSIONS.md','examples/extensions/schema.sql',
    'src/services/events.ts','tsconfig.examples.json','scripts/openapi-responses.mjs',
    'prisma/migrations/004_oidc_sign_in/migration.sql','docs/SSO.md','examples/sso-client.mjs')) {
    if ($taskRequired -notin $taskEntries) { throw "Package is missing $taskRequired" }
  }
  if ($taskEntries | Where-Object { $_ -match '(^|/)(node_modules|\.git)(/|$)|(^|/)\.env$|\.log$' }) { throw 'Unexpected private file in package' }
} finally { $taskZip.Dispose() }
$taskHasher = [Security.Cryptography.SHA256]::Create()
$taskStream = [IO.File]::OpenRead($taskArchive)
try { $taskHash = ([BitConverter]::ToString($taskHasher.ComputeHash($taskStream))).Replace('-','').ToLowerInvariant() }
finally { $taskStream.Dispose(); $taskHasher.Dispose() }
[IO.File]::WriteAllText("$taskArchive.sha256", "$taskHash  $([IO.Path]::GetFileName($taskArchive))`n")
Write-Output "Created $taskArchive"
Write-Output "SHA256 $taskHash"
