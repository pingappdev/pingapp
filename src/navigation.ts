/** Route through the shared transition controller without reloading the document. */
export function navigateTo(href:string){window.dispatchEvent(new CustomEvent('pingapp:navigate',{detail:{href}}))}
