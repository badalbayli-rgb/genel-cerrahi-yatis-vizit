# Genel Cerrahi Yatış Vizit

Güncel sürüm: **V1.6**

FONET **Poliklinik** ekranında Genel Cerrahi doktorunun `Muayene Tipi: Konsültasyon` listesine düşen hastaları tarayan, konsültasyon cevap metninde yatış kararı bulunanları ayıran ve seçilen hastalar için bağımsız Word vizit kağıdı oluşturan tarayıcı aracıdır.

## Özellikler

- Vizit Sade'den tamamen bağımsız çalışır.
- Soldaki Poliklinik hasta listesindeki tüm kayıtları, ekranda görünmeyen satırlar dahil, FONET veri kaynağından alır.
- Aynı hasta gelişine bağlı birden fazla Poliklinik satırı varsa her satırı tarama sayacına ayrı yansıtır; yinelenen ağ isteğini önbellekten karşılar.
- Her hastanın konsültasyon listesini yalnızca okuma amaçlı GET isteğiyle tarar.
- Yalnızca hedef birimi Genel Cerrahi olan konsültasyonları değerlendirir.
- `yatış uygundur`, `servisimize yatış`, `resen yatış`, `yatış verildi`, `servise kabul` ve benzeri ifadeleri yakalar.
- `yatış endikasyonu yok`, `yatışına gerek yok`, `yatış uygun değildir` ve taburculuk kararlarını dışlar.
- Bulunan kayıtları seçilebilir listede gösterir.
- Genel Cerrahi konsültasyon cevabında açık bir olumlu yatış kararı yoksa hastayı listeye almaz.
- Poliklinik listesi zaten Genel Cerrahi hedefini belirlediği için ayrıntı yanıtında birim adı boş olsa bile satırı dışlamaz; varsa sevk kimliğiyle kesin eşleştirir.
- Poliklinik satırındaki kayıt kimliğini `birimSevkId` olarak değerlendirir ve FONET sevk servisi üzerinden gerçek `hastaGelisId` değerini çözümledikten sonra konsültasyonları tarar.
- Seçilen hastalardan iki sütunlu DOCX vizit kağıdı ve CSV oluşturur.
- Word çıktısı için yatış tanısını konsültasyon cevabından, gerekirse FONET tanı kaydından alır.
- Son laboratuvar kabulünden her tetkikin güncel sonucunu derleyip Word'de tabloya koyar.
- Güncel görüntülemeleri ve varsa raporlarını ekler.
- Aynı hastane gelişindeki sevklerde bugüne ait orderları tarayıp ekler.
- Bir bölümün servisine erişilemezse çıktıda "alınamadı", veri yoksa "bulunamadı" yazar.
- Hasta verisini harici bir sunucuya göndermez; yalnızca açık FONET oturumundaki istekleri kullanır.

## Kullanım

1. `index.html` sayfasındaki **Genel Cerrahi Yatış Vizit** düğmesini yer imleri çubuğuna sürükleyin.
2. FONET'te **Poliklinik** ekranını açın.
3. Doktoru, ilk/son tarihi ve `Muayene Tipi: Konsültasyon` seçeneğini belirleyip **Sorgula**'ya basın.
4. Bookmarklet'i çalıştırıp **Listeyi Tara** düğmesine basın.
5. Araç listedeki her hastanın konsültasyon cevabını arka planda tarayana kadar bekleyin.
6. Bulunan hastaları kontrol edip **Seçilenlerden Word** ile tanı, kan tablosu, görüntüleme ve order içeren vizit kağıdını indirin. İlk indirmede bu bilgiler FONET'ten çekilir.

## Yatış kararının kapsamı

Araç yalnız konsültasyon cevap metninde olumlu yatış kararı bulunan kayıtları seçer. İstem metninde “yatış” yazması tek başına yeterli değildir. Nihai klinik doğrulama kullanıcıya aittir.

## Gizlilik

Gerçek hasta verisi tarayıcı belleğinde işlenir ve indirilen dosyaya yazılır. Dosyalar yalnız kurumun yetkili ortamında saklanmalıdır.
