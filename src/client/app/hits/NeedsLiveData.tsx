// Recent hits without Cloudflare Analytics Engine: one honest state instead of
// an empty globe and a row of zeros. Nothing on this page can show without it.

import { Link } from "react-router";
import { useCan } from "../../lib/me";
import { Button, Empty } from "../ui";

export function NeedsLiveData({ what = "The live map and the hit list" }: { what?: string }) {
  const can = useCan();
  return (
    <Empty
      className="hits-needs"
      title="Recent hits need live data"
      action={
        can("settings.manage") ? (
          <Button asChild variant="primary">
            <Link to="/settings#statistics">Connect Analytics Engine</Link>
          </Button>
        ) : undefined
      }
    >
      <p>
        {what} read each click from Cloudflare Analytics Engine, which isn’t connected to this workspace. Clicks are still counted: the Analytics page shows them from the saved daily
        statistics, a day later.
      </p>
      {can("settings.manage") ? null : <p>An owner or admin can connect it in Settings.</p>}
    </Empty>
  );
}
