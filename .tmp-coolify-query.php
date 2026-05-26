use App\Models\Application;
foreach ([3,4] as $id) {
  $app = Application::find($id);
  echo "app:$id name:" . ($app?->name ?? 'null') . " status:" . ($app?->status ?? 'null') . " fqdn:" . ($app?->fqdn ?? 'null') . PHP_EOL;
}
