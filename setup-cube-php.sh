ip addr add 192.168.0.2/24 dev eth1
localectl set-locale LANG=ja_JP.utf8
yum update -y
yum install epel-release
rpm -Uvh http://rpms.famillecollet.com/enterprise/remi-release-7.rpm
yum install -y httpd postgresql postgresql-server
yum install --enablerepo=remi,remi-php70 -y php php-pdo php-pgsql php-xml php-pecl-apcu php-pecl-zendopcache php-mbstring php-intl php-zip
cp -p /etc/php.ini /etc/php.ini.bak
echo 'date.timezone = Asia/Tokyo' >> /etc/php.ini
php -r "copy('https://getcomposer.org/installer', 'composer-setup.php');"
php composer-setup.php
php -r "unlink('composer-setup.php');"
mv composer.phar /usr/local/bin/composer
sudo -u postgres initdb -D /var/lib/pgsql/data --no-locale --encoding=UTF8
systemctl start postgresql
systemctl enable postgresql
psql -U postgres -c "CREATE USER cube3_dev_user WITH PASSWORD 'password';"
cp -p /etc/httpd/conf/httpd.conf /etc/httpd/conf/httpd.conf.bak
sed -i -e 's/AllowOverride None/AllowOverride All/' /etc/httpd/conf/httpd.conf
systemctl start httpd
systemctl enable httpd
systemctl disable firewalld
systemctl stop firewalld