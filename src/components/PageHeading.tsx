import React from 'react';

/** Shared page hierarchy: one title, a short description, and optional actions. */
export function PageHeading({ eyebrow, title, description, children }: {
  eyebrow: string;
  title: string;
  description?: string;
  children?: React.ReactNode;
}) {
  return (
    <header className="ma-page-heading">
      <div className="min-w-0">
        <p className="ma-eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        {description && <p className="ma-page-description">{description}</p>}
      </div>
      {children && <div className="ma-page-actions">{children}</div>}
    </header>
  );
}
