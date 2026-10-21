# Windows native observation

The native qualification fixture uses fixed local PowerShell queries for process
birth, parent edges, executable/command provenance and listener ownership. Before
those cmdlets run, the script assigns `PSModulePath` to the single built-in module
directory formed from the automatic `$PSHOME` installation directory and
`Modules`. The native environment projection still admits the same eight finite
system locations and fixed locale. It never inherits caller module paths,
profiles, execution-policy overrides or provider credentials.

Microsoft documents built-in Windows PowerShell modules under `$PSHOME\Modules`
and default startup construction that can combine user and system module paths.
`$PSHOME` is PowerShell's installation-directory automatic variable.
[Microsoft module path documentation](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_psmodulepath?view=powershell-7.6),
[Microsoft automatic variable documentation](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_automatic_variables?view=powershell-5.1).

Actual Windows comparisons on the same registered child showed that the finite
environment with this fixed intrinsic lookup produced the exact recorded birth
within the existing deadline. Adding APPDATA alone timed out. These measurements
support the fixed module lookup correction; they do not establish universal
necessity of individual environment fields or allow diagnostic probes to provide
cleanup authority. Original failing runs remain retained.

The three-second query deadline, 64 KiB birth/provenance output and 512 KiB /
8,192-row snapshot bounds remain unchanged. A failed query or unavailable birth
cannot become absence or authorize adoption/reaping. Every signal still requires
a fresh match to the recorded birth and registered handle or descendant edge.
Copied-app provenance retains its executable, command and owned-listener checks.
Mac control tests and pure query construction checks do not establish native
Windows acceptance; a reviewed current-head Windows rerun is required.
