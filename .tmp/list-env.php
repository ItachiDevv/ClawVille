<?php
use App\Models\Application;
$app = Application::find(3);
echo "=== api app env vars (filtered for wager/solana/encryption) ===" . PHP_EOL;
foreach ($app->environment_variables as $e) {
    $k = $e->key;
    if (
        str_contains(strtolower($k), 'wager') ||
        str_contains(strtolower($k), 'solana') ||
        $k === 'VANITY_ENCRYPTION_KEY' ||
        $k === 'CLOUDFLARE_WORKER_URL' ||
        $k === 'CLOUDFLARE_WORKER_BEARER' ||
        $k === 'DATABASE_URL'
    ) {
        $val = $e->value;
        $masked = strlen($val) > 12 ? substr($val, 0, 8) . '...' . substr($val, -4) : $val;
        echo "  $k = $masked (len " . strlen($val) . ")" . PHP_EOL;
    }
}
