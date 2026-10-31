// The catch-all: an address the admin doesn't have.

import { Link } from "react-router";

export function PageNotFound() {
  return (
    <div className="ui-page">
      <header className="ui-head">
        <h1 className="ui-h1">Page not found</h1>
      </header>
      <div className="ui-state">
        <p className="ui-state-body">This address isn’t a page of the admin. It may have moved, or the link was mistyped.</p>
        <Link to="/" className="ui-link-btn">Go to the dashboard</Link>
      </div>
    </div>
  );
}
