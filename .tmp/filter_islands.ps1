$j = Get-Content 'C:\Users\newma\Documents\Crypto\ClawVille\.tmp\casino_islands.json' -Raw | ConvertFrom-Json
$islands = $j.islands

Write-Output "=== LARGE ISLANDS (face_count >= 100) ==="
$large = $islands | Where-Object { $_.face_count -ge 100 }
Write-Output "Count: $($large.Count)"
$large | Sort-Object { $_.world_centroid[2] } -Descending | ForEach-Object {
    $wc = $_.world_centroid
    $gc = $_.glb_centroid
    $sz = $_.local_size_xyz
    Write-Output "  [$($_.island_idx)] mesh=$($_.mesh) faces=$($_.face_count) verts=$($_.vert_count)"
    Write-Output "    GLB: ($([math]::Round($gc[0],1)), $([math]::Round($gc[1],1)), $([math]::Round($gc[2],1)))"
    Write-Output "    World: ($([math]::Round($wc[0],1)), $([math]::Round($wc[1],1)), $([math]::Round($wc[2],1)))"
    Write-Output "    LocalSz: ($([math]::Round($sz[0],1)), $([math]::Round($sz[1],1)), $([math]::Round($sz[2],1)))"
}

Write-Output ""
Write-Output "=== MEDIUM ISLANDS (20 <= face_count < 100) ==="
$med = $islands | Where-Object { $_.face_count -ge 20 -and $_.face_count -lt 100 }
Write-Output "Count: $($med.Count)"
$med | Sort-Object { $_.world_centroid[2] } -Descending | ForEach-Object {
    $wc = $_.world_centroid
    $gc = $_.glb_centroid
    $sz = $_.local_size_xyz
    Write-Output "  [$($_.island_idx)] mesh=$($_.mesh) faces=$($_.face_count) verts=$($_.vert_count)"
    Write-Output "    GLB: ($([math]::Round($gc[0],1)), $([math]::Round($gc[1],1)), $([math]::Round($gc[2],1)))"
    Write-Output "    World: ($([math]::Round($wc[0],1)), $([math]::Round($wc[1],1)), $([math]::Round($wc[2],1)))"
    Write-Output "    LocalSz: ($([math]::Round($sz[0],1)), $([math]::Round($sz[1],1)), $([math]::Round($sz[2],1)))"
}

Write-Output ""
Write-Output "=== ALL MESH NAMES ==="
$islands | ForEach-Object { $_.mesh } | Sort-Object | Get-Unique
