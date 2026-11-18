param([Parameter(Mandatory)][string]$Directory)
$ErrorActionPreference = 'Stop'
foreach ($name in 'fixture', 'untrusted') {
    $key = [System.Security.Cryptography.RSA]::Create(2048)
    $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
        'CN=localhost', $key, [System.Security.Cryptography.HashAlgorithmName]::SHA256,
        [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
    $san.AddDnsName('localhost')
    $san.AddIpAddress([System.Net.IPAddress]::Loopback)
    $request.CertificateExtensions.Add($san.Build())
    $cert = $request.CreateSelfSigned([DateTimeOffset]::Now.AddDays(-1), [DateTimeOffset]::Now.AddDays(1))
    try {
        [IO.File]::WriteAllBytes((Join-Path $Directory "$name.cer"), $cert.Export('Cert'))
        [IO.File]::WriteAllBytes((Join-Path $Directory "$name.pfx"), $cert.Export('Pfx', 'bro2-test'))
    } finally {
        $cert.Dispose()
        $key.Dispose()
    }
}
