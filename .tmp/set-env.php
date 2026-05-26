<?php
use App\Models\Application;
$app = Application::find(3);

$vars = [
    'SOLANA_RPC_URL' => 'https://api.devnet.solana.com',
    'WAGER_SETTLEMENT_AUTHORITY_PUBKEY' => 'G5WgvGYK5mLxQbVUmNhFKeWwEhT235p2HjKmkbpMbMWy',
    'WAGER_PROGRAM_CLUSTER' => 'devnet',
];

foreach ($vars as $key => $value) {
    $existing = $app->environment_variables()->where('key', $key)->first();
    if ($existing) {
        $existing->update(['value' => $value]);
        echo "UPDATED $key" . PHP_EOL;
    } else {
        $app->environment_variables()->create([
            'key' => $key,
            'value' => $value,
            'is_shown_once' => false,
            'is_preview' => false,
            'is_build_time' => false,
        ]);
        echo "CREATED $key" . PHP_EOL;
    }
}
echo "Done." . PHP_EOL;
