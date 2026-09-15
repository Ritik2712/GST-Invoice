import type React from 'react'

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      /** App Bridge nav menu custom element; inert when the app is not embedded. */
      'ui-nav-menu': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>
    }
  }
}
