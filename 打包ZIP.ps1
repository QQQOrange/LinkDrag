# 生成可分发的 ZIP 备份（浏览器安装仍请使用「加载解压缩的扩展」）
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$version = (Get-Content (Join-Path $root 'extension\manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$zip = Join-Path $root ("LinkDrag-v{0}.zip" -f $version)
$stage = Join-Path $env:TEMP ("linkdrag-" + [guid]::NewGuid().ToString('N'))
try {
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  Copy-Item -Path (Join-Path $root 'extension\*') -Destination $stage -Recurse -Force
  # Chrome/Edge generate this while an unpacked extension is loaded.  It is a
  # local cache of the compiled DNR ruleset and must not ship in the ZIP.
  $metadata = Join-Path $stage '_metadata'
  if (Test-Path $metadata) { Remove-Item $metadata -Recurse -Force }
  if (Test-Path $zip) { Remove-Item $zip -Force }
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
  Write-Host "已生成 $zip"
} finally {
  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
}
