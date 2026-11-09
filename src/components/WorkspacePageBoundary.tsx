import { Component, type ReactNode } from 'react';

export class WorkspacePageBoundary extends Component<{ pageName: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="ma-dashboard-panel space-y-3" role="alert">
        <h1 className="text-lg font-bold">Couldn’t open {this.props.pageName}</h1>
        <button type="button" className="ma-text-button min-h-9" onClick={() => this.setState({ failed: false })}>
          Try again
        </button>
      </section>
    );
  }
}
