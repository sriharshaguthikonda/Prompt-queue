param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$TestArgs
)

$ErrorActionPreference = 'Stop'
$env:PYTHONDONTWRITEBYTECODE = '1'
& python -B -m pytest -p no:cacheprovider @TestArgs
$exitCode = $LASTEXITCODE

$cachePaths = @(
    (Join-Path $PSScriptRoot '..\\.pytest_cache'),
    (Join-Path $PSScriptRoot '..\\__pycache__'),
    (Join-Path $PSScriptRoot '..\\tests\\__pycache__')
)
if ($cachePaths | Where-Object { Test-Path -LiteralPath $_ }) {
    throw 'Native tests left Python or pytest cache artifacts in the extension repository.'
}
exit $exitCode
