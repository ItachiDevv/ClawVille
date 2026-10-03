export default async ({ sleep, holdKey, page, log }) => {
  log(`url=${page.url()}`);
  await sleep(1000);
  await holdKey('w', 1500);
};
