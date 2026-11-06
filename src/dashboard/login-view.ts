import { html, type Raw } from "./html.js";

export function loginBody(opts: {
    csrf: string;
    error?: string;
    locked?: number;
}): Raw {
    return html`<div class="login">
        <h1>Sign in</h1>
        <p class="sub">Enter the dashboard password.</p>
        ${opts.error ? html`<div class="alert" role="alert">${opts.error}</div>` : ""}
        <form method="post" action="/login" autocomplete="off">
            <input type="hidden" name="csrf" value="${opts.csrf}" />
            <div class="field">
                <label for="password">Password</label>
                <input
                    id="password"
                    name="password"
                    type="password"
                    autocomplete="current-password"
                    required
                    autofocus
                    maxlength="200"
                />
            </div>
            <button class="primary" type="submit">Sign in</button>
        </form>
    </div>`;
}
