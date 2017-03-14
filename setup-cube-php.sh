localectl set-locale LANG=ja_JP.utf8
yum update -y
yum install epel-release
rpm -Uvh http://rpms.famillecollet.com/enterprise/remi-release-7.rpm
yum install -y wget vim httpd postgresql postgresql-server
yum install --enablerepo=remi,remi-php70 -y php php-pdo php-pgsql php-xml php-pecl-apcu php-pecl-zendopcache php-mbstring
cp -p /etc/php.ini /etc/php.ini.bak
echo 'date.timezone = Asia/Tokyo' >> /etc/php.ini
sudo -u postgres initdb -D /var/lib/pgsql/data --no-locale --encoding=UTF8
systemctl start postgresql
systemctl enable postgresql
psql -U postgres -c "CREATE USER cube3_dev_user WITH PASSWORD 'password';"
psql -U postgres -c "CREATE DATABASE cube3_dev WITH OWNER cube3_dev_user;"
cp -p /etc/httpd/conf/httpd.conf /etc/httpd/conf/httpd.conf.bak
sed -i -e 's/AllowOverride None/AllowOverride All/' /etc/httpd/conf/httpd.conf
systemctl start httpd
systemctl enable httpd
systemctl disable firewalld
systemctl stop firewalld
(cd /var/www/html; git clone --depth=1 -b ${ECCUBE_BRANCH} ${ECCUBE_REPOSITORY}; cd ec-cube; export ROOT_URLPATH=/ec-cube/html; php eccube_install.php pgsql)
chown -R apache: /var/www/html/ec-cube
echo 'Done.'
