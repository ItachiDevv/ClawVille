use App\Models\ApplicationDeploymentQueue;
$rows = ApplicationDeploymentQueue::query()->latest()->take(10)->get();
foreach ($rows as $row) {
  echo "uuid:" . $row->deployment_uuid . " app:" . $row->application_id . " status:" . $row->status . " commit:" . ($row->commit ?? '') . " created:" . $row->created_at . PHP_EOL;
}
