---
'@sorlo/cms': minor
---

A rich text field, `lexical`, for content types and shared groups, on Lexical. It stores Lexical's JSON, with links to entries and files by ID, which Used by lists. Its `output` option says how the delivery API returns it: as HTML, by default, or as JSON, which can hold blocks, whose kinds are its `layouts`, as a flexible field's are, and whose links `with` resolves. The CMS includes it from the new `@sorlo/field-lexical`, so it needs no setup, and a site lists `lexical({ entryLinks })` in `plugins` to say where links to its entries go. Plugin fields can say what their values link to and how they're delivered, with `links`, `resolve`, `deliver` and `deliveredType`, and content migrations reach blocks in rich text as they do a flexible field's.

<!-- Release note: @sorlo/field-lexical 0.1.0 is new, so publish it by hand, as CONTRIBUTING's "A new package" says, and check it's live on npm before the Version Packages pull request merges. Otherwise the publish job fails on it and skips @sorlo/cms, which depends on it. -->
