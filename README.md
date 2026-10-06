# Genel Cerrahi Yatış Vizit

Güncel sürüm: **V1.1**

FONET **Poliklinik** ekranında Genel Cerrahi doktorunun `Muayene Tipi: Konsültasyon` listesine düşen hastaları tarayan, konsültasyon cevap metninde yatış kararı bulunanları ayıran ve seçilen hastalar için bağımsız Word vizit kağıdı oluşturan tarayıcı aracıdır.

## Özellikler

- Vizit Sade'den tamamen bağımsız çalışır.
- Soldaki Poliklinik hasta listesindeki tüm kayıtları, ekranda görünmeyen satırlar dahil, FONET veri kaynağından alır.
- Her hastanın konsültasyon listesini yalnızca okuma amaçlı GET isteğiyle tarar.
- Yalnızca hedef birimi Genel Cerrahi olan konsültasyonları değerlendirir.
- `yatış uygundur`, `servisimize yatış`, `resen yatış`, `yatış verildi`, `servise kabul` ve benzeri ifadeleri yakalar.
- `yatış endikasyonu yok`, `yatışına gerek yok`, `yatış uygun değildir` ve taburculuk kararlarını dışlar.
- Bulunan kayıtları seçilebilir listede gösterir.
- Genel Cerrahi konsültasyon cevabında açık bir olumlu yatış kararı yoksa hastayı listeye almaz.
- Seçilen hastalardan iki sütunlu DOCX vizit kağıdı ve CSV oluşturur.
- Hasta verisini harici bir sunucuya göndermez; yalnızca açık FONET oturumundaki istekleri kullanır.

## Kullanım

1. `index.html` sayfasındaki **Genel Cerrahi Yatış Vizit** düğmesini yer imleri çubuğuna sürükleyin.
2. FONET'te **Poliklinik** ekranını açın.
3. Doktoru, ilk/son tarihi ve `Muayene Tipi: Konsültasyon` seçeneğini belirleyip **Sorgula**'ya basın.
4. Bookmarklet'i çalıştırıp **Listeyi Tara** düğmesine basın.
5. Araç listedeki her hastanın konsültasyon cevabını arka planda tarayana kadar bekleyin.
6. Bulunan hastaları kontrol edip **Seçilenlerden Word** ile vizit kağıdını indirin.

## Yatış kararının kapsamı

Araç yalnız konsültasyon cevap metninde olumlu yatış kararı bulunan kayıtları seçer. İstem metninde “yatış” yazması tek başına yeterli değildir. Nihai klinik doğrulama kullanıcıya aittir.

## Gizlilik

Gerçek hasta verisi tarayıcı belleğinde işlenir ve indirilen dosyaya yazılır. Dosyalar yalnız kurumun yetkili ortamında saklanmalıdır.
