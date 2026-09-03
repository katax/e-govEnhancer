param(
  [string]$OutputPath = ''
)

$repoRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $repoRoot 'manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json

if (-not $OutputPath) {
  $OutputPath = Join-Path $repoRoot "release\egov-extension-v$($manifest.version).zip"
} elseif (-not [IO.Path]::IsPathRooted($OutputPath)) {
  $OutputPath = Join-Path $repoRoot $OutputPath
}
$OutputPath = [IO.Path]::GetFullPath($OutputPath)

if (Test-Path -LiteralPath $OutputPath) {
  throw "出力先が既に存在します。既存パッケージを保護するため中止しました: $OutputPath"
}

$catalogPath = Join-Path $repoRoot 'data\court-rules\catalog.json'
$catalogScriptPath = Join-Path $repoRoot 'shared\court-rule-catalog.js'
if (-not (Test-Path -LiteralPath $catalogPath) -or -not (Test-Path -LiteralPath $catalogScriptPath)) {
  throw '裁判所規則のカタログがありません。XML生成後にパッケージ化してください。'
}

$catalog = Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8 | ConvertFrom-Json
$catalogRules = @($catalog.rules)
if ($catalogRules.Count -ne 104) {
  throw "裁判所規則カタログが104件ではありません: $($catalogRules.Count)件"
}

$requiredRuleFiles = @($catalogRules | ForEach-Object { $_.dataPath.Replace('/', '\') })
$missingRuleFiles = @($requiredRuleFiles | Where-Object {
  -not (Test-Path -LiteralPath (Join-Path $repoRoot $_))
})
if ($missingRuleFiles.Count) {
  throw "カタログ参照先のXMLが不足しています:`n$($missingRuleFiles -join "`n")"
}

$rootFiles = @(
  'background.js',
  'content-controller.js',
  'content.css',
  'content.js',
  'inyo-dialog-bridge.js',
  'LICENSE.txt',
  'manifest.json',
  'options.css',
  'options.html',
  'options.js',
  'popup.css',
  'popup.html',
  'popup.js',
  'README.md',
  'viewer.css',
  'viewer.html',
  'viewer.js'
)
$assetDirectories = @('data', 'docs', 'icons', 'shared')
$stagingRoot = Join-Path $repoRoot "tmp\package-$([guid]::NewGuid().ToString('N'))"

try {
  New-Item -ItemType Directory -Path $stagingRoot -Force -ErrorAction Stop | Out-Null
  foreach ($file in $rootFiles) {
    $source = Join-Path $repoRoot $file
    if (-not (Test-Path -LiteralPath $source)) {
      throw "パッケージ必須ファイルがありません: $file"
    }
    Copy-Item -LiteralPath $source -Destination (Join-Path $stagingRoot $file) -ErrorAction Stop
  }
  foreach ($directory in $assetDirectories) {
    $source = Join-Path $repoRoot $directory
    if (-not (Test-Path -LiteralPath $source)) {
      throw "パッケージ必須ディレクトリがありません: $directory"
    }
    Copy-Item -LiteralPath $source -Destination (Join-Path $stagingRoot $directory) -Recurse -ErrorAction Stop
  }

  $outputDirectory = Split-Path -Parent $OutputPath
  New-Item -ItemType Directory -Path $outputDirectory -Force -ErrorAction Stop | Out-Null
  Compress-Archive -Path (Join-Path $stagingRoot '*') -DestinationPath $OutputPath -CompressionLevel Optimal -ErrorAction Stop

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [IO.Compression.ZipFile]::OpenRead($OutputPath)
  try {
    $archiveEntries = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $archive.Entries) {
      [void]$archiveEntries.Add($entry.FullName.Replace('\', '/'))
    }
    $expectedFiles = Get-ChildItem -LiteralPath $stagingRoot -Recurse -File | ForEach-Object {
      [IO.Path]::GetRelativePath($stagingRoot, $_.FullName).Replace('\', '/')
    }
    $missingArchiveFiles = @($expectedFiles | Where-Object { -not $archiveEntries.Contains($_) })
    if ($missingArchiveFiles.Count) {
      throw "ZIP内に不足ファイルがあります:`n$($missingArchiveFiles -join "`n")"
    }
    foreach ($required in @('shared/court-rule-catalog.js', 'data/court-rules/catalog.json')) {
      if (-not $archiveEntries.Contains($required)) {
        throw "ZIP内に裁判所規則の必須ファイルがありません: $required"
      }
    }
    foreach ($ruleFile in $requiredRuleFiles) {
      $entryName = $ruleFile.Replace('\', '/')
      if (-not $archiveEntries.Contains($entryName)) {
        throw "ZIP内に裁判所規則XMLがありません: $entryName"
      }
    }
    Write-Output "作成完了: $OutputPath"
    Write-Output "収録ファイル: $($expectedFiles.Count)件 / 裁判所規則XML: $($requiredRuleFiles.Count)件"
  } finally {
    $archive.Dispose()
  }
} catch {
  if (Test-Path -LiteralPath $OutputPath) {
    Remove-Item -LiteralPath $OutputPath -Force
  }
  throw
} finally {
  if (Test-Path -LiteralPath $stagingRoot) {
    $resolvedStage = [IO.Path]::GetFullPath($stagingRoot)
    $resolvedRepo = [IO.Path]::GetFullPath($repoRoot)
    if ($resolvedStage.StartsWith($resolvedRepo + [IO.Path]::DirectorySeparatorChar)) {
      Remove-Item -LiteralPath $resolvedStage -Recurse -Force
    }
  }
}
