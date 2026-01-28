$url = 'https://api.allorigins.win/raw?url=' + [uri]::EscapeDataString('https://finviz.com/screener.ashx?v=111&f=ta_pattern_wedgedown,cap_smallover,sh_avgvol_o200,sh_price_o5&o=-marketcap')
try {
    $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 30
    Write-Host "Length: $($r.Content.Length)"

    # Check for different table patterns
    if ($r.Content -match 'id="screener-content"') { Write-Host "Found: screener-content" }
    if ($r.Content -match 'screener-body-table') { Write-Host "Found: screener-body-table" }
    if ($r.Content -match 'table-light') { Write-Host "Found: table-light" }
    if ($r.Content -match 'styled-table-new') { Write-Host "Found: styled-table-new" }
    if ($r.Content -match 'screener_table') { Write-Host "Found: screener_table" }
    if ($r.Content -match 'is-table') { Write-Host "Found: is-table" }
    if ($r.Content -match 'ticker') { Write-Host "Found: ticker" }
    if ($r.Content -match 'AAPL|NVDA|TSLA|AMD') { Write-Host "Found stock tickers!" }
    if ($r.Content -match 'No Results') { Write-Host "NO RESULTS - No stocks match this pattern!" }
    if ($r.Content -match 'Total:.*0') { Write-Host "Total is 0" }

    # Look for any stock symbols
    $matches = [regex]::Matches($r.Content, 'quote\.ashx\?t=([A-Z]+)')
    if ($matches.Count -gt 0) {
        Write-Host "Found $($matches.Count) stock links!"
        Write-Host "First few: $($matches[0..4] | ForEach-Object { $_.Groups[1].Value })"
    } else {
        Write-Host "No stock links found"
    }
} catch {
    Write-Host "ERROR: $($_.Exception.Message)"
}
