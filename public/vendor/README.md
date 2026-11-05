# Self-hosted UI fonts

The application serves these fonts locally and does not contact Google Fonts or a CDN.
The approved `index.html` remains the unmodified design reference.

## @fortawesome/fontawesome-free 6.5.2

Source: https://registry.npmjs.org/@fortawesome/fontawesome-free/-/fontawesome-free-6.5.2.tgz
Archive integrity verified before extraction: `sha512-hRILoInAx8GNT5IMkrtIt9blOdrqHOnPBH+k70aWUAqPZPgopb9G5EQJFpaBx/S8zp2fC+mPW349Bziuk1o28Q==`

## @fontsource-variable/inter 5.3.0

Source: https://registry.npmjs.org/@fontsource-variable/inter/-/inter-5.3.0.tgz
Archive integrity verified before extraction: `sha512-OupL48va4JNofb97w6NYeF9S7W/kHNKM0Er8Dem5nqi4jeOLrVJDoE8tZEpnMJmtkvNbB1EIPPwHcdkF6b1oUA==`

Inter contains normal variable-weight WOFF2 subsets (weights 100–900); its CSS family is renamed from `Inter Variable` to `Inter` to retain the application design. Unicode ranges load only required subsets. `font-display: swap` is retained.

Font Awesome Free 6.5.2 includes its stylesheet, four WOFF2 fonts and license. The obsolete TTF fallback URLs are removed; the icon mappings are otherwise unchanged. Solid icons are used by dashboard navigation; public pages also use brand icons.

Original upstream licenses are retained alongside each font. No runtime package dependency or CDN download is required.
