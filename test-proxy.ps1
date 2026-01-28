$url = 'https://api.allorigins.win/raw?url=' + [uri]::EscapeDataString('https://finviz.com/screener.ashx?v=111&f=ta_pattern_wedgedown,cap_smallover,sh_avgvol_o200,sh_price_o5&o=-marketcap')
Write-Host "Testing URL: $url"
try {
    $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 30
    Write-Host "Status: $($r.StatusCode)"
    Write-Host "Length: $($r.Content.Length)"
    if ($r.Content -match 'Access Denied|blocked|403') {
        Write-Host "BLOCKED!"
    } elseif ($r.Content -match 'screener-body-table') {
        Write-Host "SUCCESS - Found stock table!"
    } else {
        Write-Host "Got response but no stock table found"
        Write-Host "First 500 chars:"
        Write-Host $r.Content.Substring(0, [Math]::Min(500, $r.Content.Length))
    }
} catch {
    Write-Host "ERROR: $($_.Exception.Message)"
}
