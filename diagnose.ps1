Write-Host "=== DIAGNOSING FINVIZ ISSUE ===" -ForegroundColor Yellow

# Test 1: Direct to Finviz
Write-Host "`nTest 1: Direct Finviz request..."
try {
    $direct = Invoke-WebRequest -Uri "https://finviz.com/screener.ashx?v=111&f=ta_pattern_wedgedown" -UseBasicParsing -TimeoutSec 15 -Headers @{"User-Agent"="Mozilla/5.0"}
    Write-Host "Direct: $($direct.StatusCode) - $($direct.Content.Length) bytes" -ForegroundColor Green
    $direct.Content | Out-File "C:\Users\surri\ai-trading-buddy\finviz_direct.html"
} catch {
    Write-Host "Direct FAILED: $($_.Exception.Message)" -ForegroundColor Red
}

# Test 2: Through local proxy
Write-Host "`nTest 2: Local proxy request..."
try {
    $proxy = Invoke-WebRequest -Uri "http://localhost:3456/?pattern=ta_pattern_wedgedown" -UseBasicParsing -TimeoutSec 15
    Write-Host "Proxy: $($proxy.StatusCode) - $($proxy.Content.Length) bytes" -ForegroundColor Green
    $proxy.Content | Out-File "C:\Users\surri\ai-trading-buddy\finviz_proxy.html"

    if ($proxy.Content -match "No matches") {
        Write-Host "RESULT: Finviz says NO MATCHES for this pattern!" -ForegroundColor Yellow
    }
    if ($proxy.Content -match "quote\.ashx") {
        Write-Host "RESULT: Found stock links - DATA IS GOOD!" -ForegroundColor Green
    }
} catch {
    Write-Host "Proxy FAILED: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host "`n=== CHECK finviz_proxy.html file to see actual response ===" -ForegroundColor Cyan
