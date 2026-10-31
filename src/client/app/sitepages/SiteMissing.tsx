// A website that doesn't exist (deleted, or a mistyped address): the same state as the dashboard's.

import { Link } from "react-router";
import { Button } from "../ui";

export function SiteMissing() {
  return (
    <div className="ui-state">
      <p className="ui-state-title">This website doesn’t exist.</p>
      <p className="ui-state-body">It may have been deleted, or the address is mistyped.</p>
      <Button asChild variant="primary">
        <Link to="/sites?list">All websites</Link>
      </Button>
    </div>
  );
}
